# TGS Payment Backend

Node.js backend for **Trader God Signals** app.
Handles Google Play purchase verification, Stripe web checkout, Firestore PRO status writes, and TwelveData market data proxying.

---

## 🗂️ Files

| File | Purpose |
|---|---|
| `server.js` | Main Express server — all API endpoints |
| `upload_strategies.js` | One-time script to upload PRO strategies to Firestore |
| `strategies.json` | List of all PRO strategy metadata objects |
| `.env` | Secret environment variables (never commit this!) |
| `package.json` | Dependencies and npm scripts |

---

## ⚙️ Setup (First Time)

### 1. Install Node.js

Download and install **Node.js v18 or higher** from [nodejs.org](https://nodejs.org/).

Verify:
```bash
node -v   # should print v18.x.x or higher
npm -v
```

---

### 2. Install Dependencies

Open a terminal inside the `backend/` folder and run:

```bash
npm install
```

This installs: `express`, `stripe`, `firebase-admin`, `googleapis`, `dotenv`, `cors`, `express-rate-limit`.

---

### 3. Configure the `.env` File

Your `.env` file already exists. Make sure every key is filled in:

```env
# ── Stripe ────────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_live_...          # From Stripe Dashboard → API Keys
STRIPE_WEBHOOK_SECRET=whsec_...       # From Stripe Dashboard → Webhooks → Signing secret
STRIPE_PRICE_MONTHLY=price_...        # From Stripe Dashboard → Products
STRIPE_PRICE_QUARTERLY=price_...
STRIPE_PRICE_ANNUAL=price_...
STRIPE_PRICE_LIFETIME=price_...

# ── Firebase ──────────────────────────────────────────────────────────────────
# Paste the ENTIRE content of your service account JSON file here (all on one line)
# OR set this to the FILE PATH of the JSON, e.g. ./serviceAccount.json
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

# ── Google Play ───────────────────────────────────────────────────────────────
# Paste the service account JSON that has androidpublisher scope
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
ANDROID_PACKAGE_NAME=com.lihov.plh

# ── TwelveData ────────────────────────────────────────────────────────────────
TWELVEDATA_API_KEY=your_key_here

# ── CORS ──────────────────────────────────────────────────────────────────────
ALLOWED_ORIGINS=https://yourdomain.com,https://yourapp.com

# ── Server ────────────────────────────────────────────────────────────────────
PORT=3000
```

> **How to get the Firebase service account JSON:**
> 1. Go to [Firebase Console](https://console.firebase.google.com/) → Project Settings → Service accounts
> 2. Click **Generate new private key**
> 3. Copy the JSON content and paste it as the value of `FIREBASE_SERVICE_ACCOUNT_JSON`

> **How to get the Google Play service account JSON:**
> 1. Go to [Google Play Console](https://play.google.com/console/) → Setup → API access
> 2. Link to Google Cloud → create a service account with **Android Publisher** role
> 3. Download the JSON key and paste it in `GOOGLE_SERVICE_ACCOUNT_JSON`

---

## 🚀 Running Locally (Development)

```bash
npm run dev
```

This starts the server with auto-restart on file changes (uses `nodemon`).

The server will run at: `http://localhost:3000`

Test the health check:
```bash
curl http://localhost:3000/health
# → {"status":"ok","ts":1234567890}
```

---

## 🌐 Running in Production

```bash
npm start
```

---

## 📦 Uploading PRO Strategies to Firestore

After adding or changing a strategy in `strategies.json`, sync it to Firestore:

```bash
node upload_strategies.js
```

This writes all strategies to the Firestore document `config/strategies`.
The Android app fetches from this path to unlock PRO strategy chips dynamically.

> ✅ Run this every time you add a new strategy (like `ICT_DEEP_TP`).

---

## ☁️ Deploy to Railway (Step by Step)

A `railway.toml` is already set up in this folder — Railway will automatically detect build and start commands.

### Step 1 — Push backend to GitHub

> **Important:** Push only the `backend/` folder contents (not the whole Android project).

Create a new GitHub repo (e.g. `tgs-backend`) and push:

```bash
cd backend
git init
git add .
git commit -m "initial backend"
git remote add origin https://github.com/YOUR_USERNAME/tgs-backend.git
git push -u origin main
```

---

### Step 2 — Create Railway project

1. Go to [railway.app](https://railway.app/) and sign in
2. Click **New Project**
3. Choose **Deploy from GitHub repo**
4. Select your `tgs-backend` repo
5. Railway auto-detects Node.js and starts deploying

---

### Step 3 — Add Environment Variables

In Railway dashboard → your service → **Variables** tab, add each of these:

| Variable | Value | Where to find it |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` | [Stripe Dashboard → API Keys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Stripe → Webhooks → your endpoint → Signing secret |
| `STRIPE_PRICE_MONTHLY` | `price_...` | Stripe → Products → Monthly price ID |
| `STRIPE_PRICE_QUARTERLY` | `price_...` | Stripe → Products → Quarterly price ID |
| `STRIPE_PRICE_ANNUAL` | `price_...` | Stripe → Products → Annual price ID |
| `STRIPE_PRICE_LIFETIME` | `price_...` | Stripe → Products → Lifetime price ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account",...}` | Firebase Console → Project Settings → Service accounts → Generate key → copy entire JSON |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account",...}` | Google Play Console → Setup → API access → Service account key JSON |
| `ANDROID_PACKAGE_NAME` | `com.lihov.plh` | Your app's package name |
| `TWELVEDATA_API_KEY` | `your_key` | [twelvedata.com](https://twelvedata.com/) → Dashboard |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` | Your web landing page domain (or `*` for testing) |

> **Tip for JSON values:** In Railway, paste the raw JSON content as the value — no quotes around it, no escaping needed.

---

### Step 4 — Get Your Live URL

1. Railway dashboard → your service → **Settings** tab
2. Under **Domains**, click **Generate Domain**
3. Copy the URL — it looks like: `https://tgs-backend-production.up.railway.app`

---

### Step 5 — Set the URL in Android App

Find the file where your backend URL is configured (usually `AppConfig.kt` or `network_security_config.xml`) and set:
```kotlin
const val BASE_URL = "https://tgs-backend-production.up.railway.app"
```

---

### Step 6 — Configure Stripe Webhook

1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **Add endpoint**
3. URL: `https://your-railway-url.up.railway.app/webhook/stripe`
4. Events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
5. Copy the **Signing secret** (`whsec_...`) and add it to Railway as `STRIPE_WEBHOOK_SECRET`

---

### Step 7 — Verify It's Running

```bash
curl https://your-railway-url.up.railway.app/health
# → {"status":"ok","ts":1234567890}
```

If health check returns `ok` — your backend is live. ✅

---

### Redeploy After Changes

Push to GitHub → Railway auto-redeploys:
```bash
git add .
git commit -m "update"
git push
```


---

## 🔌 API Endpoints

### `GET /health`
Liveness check — returns `{ "status": "ok" }`.
Used by Railway / Render uptime monitoring.

---

### `POST /verify-purchase`
Validates a Google Play or Stripe purchase and grants PRO in Firestore.

**Request body:**
```json
{
  "uid": "firebase_user_uid",
  "packageName": "com.lihov.plh",
  "productId": "tgs_pro_monthly",
  "purchaseToken": "the_token_from_google_play"
}
```

**Response:**
```json
{ "valid": true, "expiresAt": 1712345678000 }
```
or
```json
{ "valid": false, "reason": "subscription_expired" }
```

**Supports two payment paths:**
- `purchaseToken` starts with `cs_` → Stripe session verification
- Anything else → Google Play Developer API verification

---

### `GET /checkout`
Creates a Stripe Checkout session for web-based fallback payment.

**Query params:** `uid`, `plan`, `success_url`, `cancel_url`

**Plans:** `tgs_pro_monthly` | `tgs_pro_quarterly` | `tgs_pro_annual` | `tgs_pro_lifetime`

**Response:** Redirects (302) to the Stripe hosted checkout page.

---

### `POST /webhook/stripe`
Stripe webhook endpoint — called by Stripe for payment events.

Configure this URL in Stripe Dashboard → Webhooks:
```
https://your-deployed-url.com/webhook/stripe
```

Handles:
- `checkout.session.completed` → grants PRO in Firestore
- `customer.subscription.deleted` → revokes PRO in Firestore

---

### `GET /api/v1/market/quote?symbol=XAUUSD`
### `GET /api/v1/market/time_series?symbol=XAUUSD&interval=1h&outputsize=60`

Proxies requests to TwelveData API (hides the API key from the Android client).

---

## 🔐 Security Notes

- **Never commit `.env`** — it contains live secret keys
- `STRIPE_WEBHOOK_SECRET` **must** be set or the webhook endpoint will reject all requests
- Rate limiting is enabled on `/verify-purchase` and `/api/*` — 100 req/15 min per IP
- CORS only allows origins listed in `ALLOWED_ORIGINS`

---

## 🧪 Testing Without Real Keys

If `GOOGLE_SERVICE_ACCOUNT_JSON` is not set, `/verify-purchase` will fall back to **test mode** — it grants PRO for 30 days without actually calling Google Play.

If `FIREBASE_SERVICE_ACCOUNT_JSON` is not set, the server starts but skips all Firestore writes (logs a warning).

This lets you test locally without needing all credentials ready.
