const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

function getReplicateAgent() {
    if (!proxyUrl || !/^http/i.test(proxyUrl)) return undefined;
    try { return new HttpsProxyAgent(proxyUrl); } catch { return undefined; }
}

function replicateFetch(url, opts = {}) {
    const agent = getReplicateAgent();
    return fetch(url, { agent, ...opts });
}

module.exports = { getReplicateAgent, replicateFetch };
