// utils/errors.js

function httpError(status, message, extra = {}) {
    const err = new Error(message || 'Error');
    err.status = status;
    Object.assign(err, extra);
    return err;
}

function toHttp(res, e) {
    const code = Number(e?.status || e?.statusCode || 500);
    const msg = e?.message || 'Internal Error';
    const body = e?.body || undefined;
    res.status(code >= 400 && code < 600 ? code : 500).json({ ok: false, error: msg, ...(body ? { body } : {}) });
}

module.exports = { httpError, toHttp };
