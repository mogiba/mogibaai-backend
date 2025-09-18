function normalizeOutputUrls(pred) {
    const out = pred && pred.output;
    if (!out) return [];
    if (Array.isArray(out)) {
        return out
            .map(x => (typeof x === 'string' ? x : (x && (x.url || x.uri || x.path || x.image))))
            .filter(Boolean);
    }
    if (typeof out === 'string') return [out];
    if (typeof out === 'object') {
        const acc = [];
        if (Array.isArray(out.images)) acc.push.apply(acc, out.images);
        ['url', 'uri', 'path', 'image'].forEach(function (k) { if (out[k]) acc.push(out[k]); });
        return acc.filter(Boolean);
    }
    return [];
}

module.exports = { normalizeOutputUrls };
