const { admin } = require('../utils/firebaseUtils');

// Verify Firebase ID token and set req.uid. If INTERNAL_CALL_SECRET is set and
// header 'x-internal-secret' matches, allow x-uid fallback for internal calls.
module.exports = async function requireAuth(req, res, next) {
  try {
    const DEBUG = Boolean(process.env.DEBUG_RAZORPAY === '1' || process.env.DEBUG === '1');
    const authHeader = (req.headers['authorization'] || req.headers['x-forwarded-authorization'] || '').toString();
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        if (decoded && decoded.uid) {
          req.uid = decoded.uid;
          req.uid_source = 'token';
          if (DEBUG) console.log('[DEBUG_RAZORPAY][auth] uid via token =', decoded.uid);
          return next();
        }
      } catch (e) {
        if (DEBUG) console.warn('[DEBUG_RAZORPAY][auth] token verify failed:', e && e.message ? e.message : e);
      }
    }

    const internalSecret = process.env.INTERNAL_CALL_SECRET || '';
    const provided = (req.headers['x-internal-secret'] || '').toString();
    if (internalSecret && provided && internalSecret === provided) {
      const xuid = (req.headers['x-uid'] || req.query?.uid || req.body?.uid || '').toString();
      if (xuid) {
        req.uid = xuid;
        req.uid_source = 'internal';
        return next();
      }
    }

    return res.status(401).json({ message: 'Unauthorized: valid Firebase ID token required' });
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};
