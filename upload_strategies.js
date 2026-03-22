require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
try {
  const fbEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!fbEnv) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing from .env");
  }
  const fbCredentials = fbEnv.trim().startsWith('{') 
    ? JSON.parse(fbEnv) 
    : require(path.resolve(fbEnv));

  if (fbCredentials.private_key) {
    fbCredentials.private_key = fbCredentials.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(fbCredentials),
  });
  console.log("✅ Firebase Admin initialized successfully.");
} catch (e) {
  console.error("❌ Firebase Admin SDK not configured correctly: ", e.message);
  process.exit(1);
}

const firestore = admin.firestore();

async function uploadStrategies() {
  try {
    const dataPath = path.join(__dirname, 'strategies.json');
    const strategiesData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    console.log(`Uploading ${strategiesData.length} strategies to Firestore...`);
    
    // We will store all strategies inside a single document "config/strategies" for easy fetching
    const docRef = firestore.collection('config').doc('strategies');
    await docRef.set({ strategies: strategiesData }, { merge: true });

    console.log("✅ Successfully uploaded strategies to Firestore (config/strategies)!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error uploading strategies:", error);
    process.exit(1);
  }
}

uploadStrategies();
