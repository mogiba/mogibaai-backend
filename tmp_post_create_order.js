const http = require('http');
const https = require('https');
const url = require('url');

async function post() {
    const data = JSON.stringify({ planId: 'img_baby_300' });
    const parsed = url.parse('http://localhost:4000/api/payments/razorpay/create-order');
    const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Origin': 'http://localhost:3000',
            'Authorization': 'Bearer test_fake_token_123'
        }
    };

    const req = http.request(options, (res) => {
        console.log('STATUS', res.statusCode);
        console.log('HEADERS', res.headers);
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            console.log('BODY', body);
            process.exit(0);
        });
    });

    req.on('error', (e) => { console.error('Request error', e); process.exit(1); });
    req.write(data);
    req.end();
}
post();
