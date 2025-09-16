const { db } = require('../utils/firebaseUtils');

function hasBlockedTerms(text = '') {
    const s = String(text || '').toLowerCase();
    const blocked = [
        'csam', 'child sexual', 'child porn', 'terror manual', 'bomb making',
    ];
    return blocked.some(k => s.includes(k));
}

function validateDimensions(w, h) {
    const W = Number(w || 0); const H = Number(h || 0);
    if (!W || !H) return { ok: true };
    if (W > 4096 || H > 4096) return { ok: false, reason: 'DIMENSIONS_TOO_LARGE' };
    return { ok: true };
}

function exifHasGps(meta = {}) {
    return Boolean(meta && meta.gps && (meta.gps.lat || meta.gps.lng));
}

async function logModerationEvent({ uid, jobId, code, reason, prompt, imageUrl }) {
    try {
        const ref = db.collection('moderationEvents').doc();
        await ref.set({ uid: uid || null, jobId: jobId || null, code, reason, prompt: prompt || '', imageUrl: imageUrl || null, createdAt: new Date() });
    } catch { }
}

function moderateInput({ prompt, negative_prompt, width, height, imageMeta, imageUrl }) {
    if (hasBlockedTerms(prompt) || hasBlockedTerms(negative_prompt)) {
        return { ok: false, code: 'MODERATION_BLOCKED', reason: 'Blocked prompt terms' };
    }
    const dim = validateDimensions(width, height);
    if (!dim.ok) return { ok: false, code: 'INVALID_INPUT', reason: dim.reason };
    if (exifHasGps(imageMeta)) {
        return { ok: false, code: 'INVALID_INPUT', reason: 'IMAGE_HAS_GPS_EXIF' };
    }
    // Optional: attach simple image URL rule checks (file extension heuristic)
    if (imageUrl && typeof imageUrl === 'string') {
        const lower = imageUrl.toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
        if (!allowed.some(ext => lower.includes(ext))) {
            // not hard block; but can signal weak signal
        }
    }
    return { ok: true };
}

module.exports = { moderateInput, logModerationEvent };

async function moderateImageBuffer(buf) {
    // Rekognition removed in Firebase-only mode; keep as allow-by-default hook.
    return { ok: true, reason: 'image_scan_disabled' };
}

module.exports.moderateImageBuffer = moderateImageBuffer;
