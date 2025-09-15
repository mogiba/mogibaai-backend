const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');

const PRIVATE_CIDRS = [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['127.0.0.0', 8],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
];

function ipToBuffer(ip) {
    return net.isIPv6(ip) ? Buffer.from(ip.split(':').map(x => parseInt(x || '0', 16))) : Buffer.from(ip.split('.').map(x => parseInt(x, 10)));
}

function isPrivateIp(ip) {
    try {
        if (net.isIPv4(ip)) {
            const parts = ip.split('.').map(n => parseInt(n, 10));
            if (parts[0] === 10) return true;
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
            if (parts[0] === 192 && parts[1] === 168) return true;
            if (parts[0] === 127) return true;
        }
        if (net.isIPv6(ip)) {
            if (ip === '::1') return true; // loopback
            if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local
            if (ip.startsWith('fe80')) return true; // link-local
        }
    } catch { }
    return false;
}

async function safeResolveHost(hostname) {
    const ips = await dns.lookup(hostname, { all: true }).catch(() => []);
    for (const rec of ips) {
        if (isPrivateIp(rec.address)) {
            const err = new Error('Blocked private or loopback address');
            err.code = 'SSRF_BLOCKED';
            throw err;
        }
    }
    return ips.map(r => r.address);
}

async function safeFetchHead(url) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        const err = new Error('Only http(s) URLs are allowed');
        err.code = 'INVALID_URL';
        throw err;
    }
    if ([
        'localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal',
    ].includes(u.hostname)) {
        const err = new Error('Blocked internal/localhost URLs');
        err.code = 'SSRF_BLOCKED';
        throw err;
    }
    await safeResolveHost(u.hostname);
    const resp = await axios.head(url, { timeout: 8000, maxRedirects: 2 }).catch((e) => {
        const err = new Error('HEAD request failed');
        err.code = 'URL_UNREACHABLE';
        err.details = e && e.message;
        throw err;
    });
    return {
        status: resp.status,
        headers: resp.headers,
        contentType: (resp.headers['content-type'] || '').split(';')[0],
        contentLength: Number(resp.headers['content-length'] || 0),
    };
}

module.exports = { safeFetchHead };
