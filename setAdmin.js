const admin = require("firebase-admin");
const serviceAccount = require("./secrets/sa-key.json"); // 🔑 nee daggara unna Firebase service account file path

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Replace with the UID of the user you want to make admin
const uid = "VVSmMEayxDXDe0Yw6IJp1oOtDEL2";

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log(`✅ Admin claim set for user: ${uid}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Error setting admin claim:", error);
    process.exit(1);
  });
