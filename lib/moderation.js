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
    if (W > 2048 || H > 2048) return { ok: false, reason: 'DIMENSIONS_TOO_LARGE' };
    return { ok: true };
}

function exifHasGps(meta = {}) {
    return Boolean(meta && meta.gps && (meta.gps.lat || meta.gps.lng));
}

function moderateInput({ prompt, negative_prompt, width, height, imageMeta }) {
    if (hasBlockedTerms(prompt) || hasBlockedTerms(negative_prompt)) {
        return { ok: false, code: 'MODERATION_BLOCKED', reason: 'Blocked prompt terms' };
    }
    const dim = validateDimensions(width, height);
    if (!dim.ok) return { ok: false, code: 'INVALID_INPUT', reason: dim.reason };
    if (exifHasGps(imageMeta)) {
        return { ok: false, code: 'INVALID_INPUT', reason: 'IMAGE_HAS_GPS_EXIF' };
    }
    return { ok: true };
}

module.exports = { moderateInput };
