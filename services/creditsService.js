const { db, admin } = require("../utils/firebaseUtils");

// 🔹 యూజర్ క్రెడిట్స్ తీసుకోవడం
async function getUserCredits(uid) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      credits_image: 0,
      credits_video: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { credits_image: 0, credits_video: 0 };
  }

  const d = snap.data();
  return {
    credits_image: d.credits_image || 0,
    credits_video: d.credits_video || 0,
  };
}

// 🔹 యూజర్ క్రెడిట్స్ deduct (spend)
async function spendCredit(uid, category, qty = 1) {
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (t) => {
    const doc = await t.get(userRef);
    if (!doc.exists) throw new Error("USER_NOT_FOUND");

    const data = doc.data();
    const field = category === "video" ? "credits_video" : "credits_image";
    const cur = data[field] || 0;

    if (cur < qty) throw new Error("INSUFFICIENT_CREDITS");

    t.update(userRef, {
      [field]: cur - qty,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const txRef = db.collection("creditTransactions").doc();
    t.set(txRef, {
      uid,
      type: "spend",
      amountCredits: qty,
      category,
      status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return true;
}

// 🔹 యూజర్‌కి క్రెడిట్స్ add చేయడం (top-up)
async function addCredits(uid, category, qty, meta = {}) {
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (t) => {
    const doc = await t.get(userRef);
    const base = doc.exists ? doc.data() : {};
    const field = category === "video" ? "credits_video" : "credits_image";
    const cur = base[field] || 0;

    t.set(
      userRef,
      {
        [field]: cur + qty,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const txRef = db.collection("creditTransactions").doc();
    t.set(txRef, {
      uid,
      type: "topup",
      amountCredits: qty,
      category,
      status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...meta,
    });
  });

  return true;
}

module.exports = { getUserCredits, spendCredit, addCredits };
