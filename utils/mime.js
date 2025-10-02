// utils/mime.js

const ALLOWED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function isAllowedImage(ct) {
    const s = String(ct || '').toLowerCase();
    return ALLOWED.has(s);
}

function extByContentType(ct) {
    const s = String(ct || '').toLowerCase();
    if (s.includes('jpeg') || s.includes('jpg')) return 'jpg';
    if (s.includes('png')) return 'png';
    if (s.includes('webp')) return 'webp';
    return 'bin';
}

module.exports = { isAllowedImage, extByContentType };
