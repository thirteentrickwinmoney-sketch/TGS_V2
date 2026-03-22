'use strict';

/**
 * TGS Payment Backend — server.js
 *
 * Endpoints:
 *   POST /verify-purchase   — validate a Google Play purchaseToken in real-time
 *   GET  /checkout          — create a Stripe Checkout Session and redirect
 *   POST /webhook/stripe    — handle Stripe events (checkout.session.completed)
 *   GET  /health            — liveness check for hosting platforms
 *
 * Deploy on Railway / Render / Fly.io:
 *   1. Push this folder to a GitHub repo
 *   2. Connect the repo on railway.app (or render.com)
 *   3. Set all .env.example variables as environment secrets
 *   4. Done — the platform builds & starts with `npm start`
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { google } = require('googleapis');
const admin      = require('firebase-admin');
const Stripe     = require('stripe');

// ── Validate required environment variables ───────────────────────────────────
const REQUIRED_VARS = [
  'STRIPE_SECRET_KEY'
];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`[TGS] ❌  Missing required env var: ${v}`);
    process.exit(1);
  }
}

// ── Initialize clients ────────────────────────────────────────────────────────

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

// Firebase Admin
let firestore = null;
try {
  const fbEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const fbCredentials = fbEnv.trim().startsWith('{') 
    ? JSON.parse(fbEnv) 
    : require(require('path').resolve(fbEnv));

  if (fbCredentials.private_key) {
    fbCredentials.private_key = fbCredentials.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(fbCredentials),
  });
  firestore = admin.firestore();
} catch (e) {
  console.warn("⚠️  Firebase Admin SDK not fully configured. Proceeding without it. Error: " + e.message);
}

// Google Play Developer API (via Service Account)
let androidPublisher = null;
try {
  const googleEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const googleCredentials = googleEnv.trim().startsWith('{')
    ? JSON.parse(googleEnv)
    : require(require('path').resolve(googleEnv));

  if (googleCredentials.private_key) {
    googleCredentials.private_key = googleCredentials.private_key.replace(/\\n/g, '\n');
  }
  const googleAuth = new google.auth.GoogleAuth({
    credentials: googleCredentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  androidPublisher = google.androidpublisher({ version: 'v3', auth: googleAuth });
} catch (e) {
  console.warn("⚠️  Google Play Developer API not fully configured. Proceeding without it. Error: " + e.message);
}

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME;

// Stripe price map — maps Play product IDs → Stripe price IDs
const PRICE_MAP = {
  tgs_pro_monthly:   process.env.STRIPE_PRICE_MONTHLY,
  tgs_pro_quarterly: process.env.STRIPE_PRICE_QUARTERLY,
  tgs_pro_annual:    process.env.STRIPE_PRICE_ANNUAL,
  tgs_pro_lifetime:  process.env.STRIPE_PRICE_LIFETIME,
};

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();

// CORS — allow your app landing page and the Android WebView
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Android WebView, Postman)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

// Raw body for Stripe webhook signature verification (must come before json())
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

// JSON body for all other routes
app.use(express.json());

// Set up rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});

// Apply rate limiting to critical endpoints
app.use('/verify-purchase', apiLimiter);
app.use('/api', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Simple liveness check used by Railway / Render health probes.
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify-purchase
//
// Validates a Google Play purchaseToken against the Play Developer API.
// Called by Android's PurchaseVerifier.kt immediately after a purchase.
//
// Body: { uid, packageName, productId, purchaseToken }
// Response: { valid: boolean, expiresAt?: number, reason?: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-purchase', async (req, res) => {
  const { uid, packageName, productId, purchaseToken } = req.body;

  if (!uid || !productId || !purchaseToken) {
    return res.status(400).json({ valid: false, reason: 'missing_fields' });
  }
  if (packageName && packageName !== PACKAGE_NAME) {
    return res.status(400).json({ valid: false, reason: 'wrong_package' });
  }

  try {
    const isLifetime = productId === 'tgs_pro_lifetime';

    // ── Scenario A: Stripe Checkout Session (Web Fallback) ───────────────────
    if (purchaseToken.startsWith('cs_')) {
      console.log(`[TGS] Verifying Stripe Session: ${purchaseToken}`);
      const session = await stripe.checkout.sessions.retrieve(purchaseToken);
      
      // status 'complete' and payment_status 'paid'
      if (session.status !== 'complete' || session.payment_status !== 'paid') {
        return res.json({ valid: false, reason: `stripe_status_${session.status}_${session.payment_status}` });
      }

      // For subscriptions, get expiry
      let expiresAt = 0;
      if (!isLifetime && session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          expiresAt = sub.current_period_end * 1000;
        } catch (e) {
          expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        }
      }

      await grantProInFirestore(uid, productId, `stripe_${session.id}`, expiresAt);
      return res.json({ valid: true, expiresAt });
    }

    // ── Scenario B: Google Play Billing (Primary) ────────────────────────────
    if (!androidPublisher) {
      console.warn(`[TGS] ⚠️ Google Play API not configured. Creating TEST verification for ${productId}`);
      const testExpiresAt = isLifetime ? 0 : Date.now() + 30 * 24 * 60 * 60 * 1000;
      await grantProInFirestore(uid, productId, purchaseToken, testExpiresAt);
      return res.json({ valid: true, expiresAt: testExpiresAt });
    }

    if (isLifetime) {
      // One-time purchase — use products.get
      const { data } = await androidPublisher.purchases.products.get({
        packageName,
        productId,
        token: purchaseToken,
      });

      // purchaseState 0 = purchased, 1 = cancelled, 2 = pending
      if (data.purchaseState !== 0) {
        return res.json({ valid: false, reason: `purchase_state_${data.purchaseState}` });
      }

      await grantProInFirestore(uid, productId, purchaseToken, 0);
      return res.json({ valid: true, expiresAt: 0 });

    } else {
      // Subscription — use subscriptions.get
      const { data } = await androidPublisher.purchases.subscriptions.get({
        packageName,
        subscriptionId: productId,
        token: purchaseToken,
      });

      // paymentState: 0=pending, 1=received, 2=free trial, 3=pending deferred
      if (data.paymentState !== 1 && data.paymentState !== 2) {
        return res.json({ valid: false, reason: `payment_state_${data.paymentState}` });
      }

      const expiresAt = parseInt(data.expiryTimeMillis, 10);
      if (Date.now() > expiresAt) {
        await revokeProInFirestore(uid);
        return res.json({ valid: false, reason: 'subscription_expired', expiresAt });
      }

      await grantProInFirestore(uid, productId, purchaseToken, expiresAt);
      return res.json({ valid: true, expiresAt });
    }

  } catch (err) {
    console.error('[TGS] verify-purchase error:', err.message);
    // If Play API responds 404 the token is invalid / belongs to another user
    if (err.code === 404 || err.status === 404) {
      return res.json({ valid: false, reason: 'token_not_found' });
    }
    // Unexpected server error — return 500 so the app uses optimistic fallback
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /checkout
//
// Creates a Stripe Checkout Session for web-based purchase (fallback path).
// Used by WebCheckoutActivity via WebPaymentManager.buildCheckoutUrl().
//
// Query params: uid, plan, platform, success_url, cancel_url
// Response: 302 redirect to Stripe hosted payment page
// ─────────────────────────────────────────────────────────────────────────────
app.get('/checkout', async (req, res) => {
  const { uid, plan, platform, success_url, cancel_url } = req.query;

  if (!uid || !plan || !success_url || !cancel_url) {
    return res.status(400).send('Missing required query params: uid, plan, success_url, cancel_url');
  }

  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return res.status(400).send(`Unknown plan: ${plan}`);
  }

  try {
    const isLifetime = plan === 'tgs_pro_lifetime';

    const successUrlWithMeta =
      `${success_url}?plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`;

    const sessionParams = {
      mode:        isLifetime ? 'payment' : 'subscription',
      line_items:  [{ price: priceId, quantity: 1 }],
      success_url: successUrlWithMeta,
      cancel_url:  cancel_url,
      metadata: {
        uid,
        plan,
        platform: platform || 'android',
      },
    };

    // customer_creation is only allowed in 'payment' mode.
    // In 'subscription' mode, a customer is always created automatically.
    if (isLifetime) {
      sessionParams.customer_creation = 'always';
    }

    // Retrieve customer email from Firestore to pre-fill Stripe form
    try {
      const userDoc = await firestore.collection('users').doc(uid).get();
      if (userDoc.exists) {
        const email = userDoc.data().email;
        if (email) sessionParams.customer_email = email;
      }
    } catch (e) {
      // Non-critical — Stripe form will ask for email
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log(`[TGS] Checkout session created: ${session.id} for uid=${uid} plan=${plan}`);

    // Redirect client to Stripe-hosted checkout page
    return res.redirect(303, session.url);

  } catch (err) {
    console.error('[TGS] /checkout error:', err.message);
    return res.status(500).send(`Checkout error: ${err.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/stripe
//
// Receives Stripe events. The most important one is checkout.session.completed
// which fires when the web checkout flow succeeds. We grant PRO here so the
// user gets access even if the app WebView fails to intercept the redirect.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || webhookSecret.includes('YOUR_WEBHOOK_SIGNING_SECRET')) {
      console.error('[TGS] CRITICAL SECURITY ERROR: STRIPE_WEBHOOK_SECRET is not configured. Rejecting webhook.');
      return res.status(500).send('Server misconfiguration: missing webhook secret.');
    }
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[TGS] Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const uid      = session.metadata?.uid;
    const plan     = session.metadata?.plan;

    if (uid && plan) {
      const isLifetime = plan === 'tgs_pro_lifetime';

      // For subscriptions, get expiry from the subscription object
      let expiresAt = 0;
      if (!isLifetime && session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          expiresAt = sub.current_period_end * 1000; // convert to ms
        } catch (e) {
          expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // fallback: 30 days
        }
      }

      await grantProInFirestore(uid, plan, `stripe_${session.id}`, expiresAt);
      console.log(`[TGS] ✅ Stripe webhook: PRO granted uid=${uid} plan=${plan}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Subscription was cancelled / expired — revoke PRO
    const sub = event.data.object;
    const uid = sub.metadata?.uid;
    if (uid) {
      await revokeProInFirestore(uid);
      console.log(`[TGS] Stripe webhook: PRO revoked uid=${uid}`);
    }
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/market/quote
// GET /api/v1/market/time_series
//
// Proxies requests to TwelveData to hide the API key from the Android client.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/market/quote', async (req, res) => {
  const { symbol } = req.query;
  const apiKey = process.env.TWELVEDATA_API_KEY;

  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  if (!apiKey) return res.status(500).json({ error: 'Server missing API Key' });

  try {
    const response = await fetch(`https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${apiKey}`);
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[TGS] TwelveData /quote error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

app.get('/api/v1/market/time_series', async (req, res) => {
  const { symbol, interval, outputsize } = req.query;
  const apiKey = process.env.TWELVEDATA_API_KEY;

  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  if (!apiKey) return res.status(500).json({ error: 'Server missing API Key' });

  const i = interval || '1h';
  const size = outputsize || '60';

  try {
    const response = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${i}&outputsize=${size}&apikey=${apiKey}`);
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[TGS] TwelveData /time_series error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch time_series' });
  }
});

// ── Firestore helpers ─────────────────────────────────────────────────────────

/**
 * Writes isPro=true to the user's Firestore document.
 */
async function grantProInFirestore(uid, planId, purchaseToken, expiresAt) {
  try {
    await firestore.collection('users').doc(uid).set({
      isPro:         true,
      planId,
      purchaseToken,
      proExpiresAt:  expiresAt,
      lastSeenAt:    Date.now(),
    }, { merge: true });
  } catch (e) {
    console.error('[TGS] Firestore grantPro failed:', e.message);
  }
}

/**
 * Revokes PRO status in Firestore (subscription expired or cancelled).
 */
async function revokeProInFirestore(uid) {
  try {
    await firestore.collection('users').doc(uid).set({
      isPro:        false,
      proExpiresAt: 0,
      lastSeenAt:   Date.now(),
    }, { merge: true });
  } catch (e) {
    console.error('[TGS] Firestore revokePro failed:', e.message);
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[TGS] 🚀 Payment backend running on port ${PORT}`);
  console.log(`[TGS]    POST /verify-purchase`);
  console.log(`[TGS]    GET  /checkout`);
  console.log(`[TGS]    POST /webhook/stripe`);
  console.log(`[TGS]    GET  /health`);
});

module.exports = app;
