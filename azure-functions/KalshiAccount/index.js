// Kalshi account proxy. Decrypts the browser-encrypted credential only in memory.
// Required Azure settings:
// KALSHI_ENCRYPTION_PUBLIC_KEY  - RSA public key (SPKI PEM)
// KALSHI_ENCRYPTION_PRIVATE_KEY - matching RSA private key (PKCS8 PEM)
// KALSHI_ENVIRONMENT            - production (default) or demo
const { app } = require('@azure/functions');
const crypto = require('node:crypto');

const PREFIX = '/trade-api/v2';
const HOSTS = {
  production: 'https://external-api.kalshi.com',
  demo: 'https://external-api.demo.kalshi.co',
};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function response(status, jsonBody) {
  return { status, headers: cors, jsonBody };
}
function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, ''), 'base64');
}
function decryptCredential(envelope) {
  const privatePem = process.env.KALSHI_ENCRYPTION_PRIVATE_KEY;
  if (!privatePem) throw new Error('Azure setting KALSHI_ENCRYPTION_PRIVATE_KEY is missing.');
  const wrappedKey = Buffer.from(envelope.encryptedKey, 'base64');
  const key = crypto.privateDecrypt({
    key: privatePem,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, wrappedKey);
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
function signRequest(keyId, privatePem, method, path) {
  const timestamp = String(Date.now());
  const message = Buffer.from(timestamp + method.toUpperCase() + path.split('?')[0], 'utf8');
  const privateKey = crypto.createPrivateKey(privatePem);
  const signature = privateKey.asymmetricKeyType === 'ed25519'
    ? crypto.sign(null, message, privateKey)
    : crypto.sign('sha256', message, {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    Accept: 'application/json',
  };
}

app.http('KalshiAccount', {
  route: 'KalshiAccount',
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') return { status: 204, headers: cors };
    try {
      if (request.method === 'GET') {
        if (request.query.get('action') !== 'publicKey') {
          return response(400, { error: 'Use ?action=publicKey.' });
        }
        const publicKey = process.env.KALSHI_ENCRYPTION_PUBLIC_KEY;
        if (!publicKey) return response(503, { error: 'Azure setting KALSHI_ENCRYPTION_PUBLIC_KEY is missing.' });
        return response(200, { publicKey });
      }

      const body = await request.json();
      const keyId = String(body.keyId || '').trim();
      if (!keyId || keyId.length > 128) return response(400, { error: 'A valid Kalshi API Key ID is required.' });
      if (!body.envelope?.encryptedKey || !body.envelope?.iv || !body.envelope?.ciphertext) {
        return response(400, { error: 'Encrypted credential envelope is incomplete.' });
      }

      const privatePem = decryptCredential(body.envelope);
      const environment = process.env.KALSHI_ENVIRONMENT === 'demo' ? 'demo' : 'production';
      const path = PREFIX + '/portfolio/balance';
      const headers = signRequest(keyId, privatePem, 'GET', path);
      const upstream = await fetch(HOSTS[environment] + path, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        context.warn('Kalshi balance request failed with HTTP ' + upstream.status);
        return response(upstream.status === 401 ? 401 : 502, {
          error: 'Kalshi account verification failed.',
          kalshiStatus: upstream.status,
          detail: payload?.error?.details || payload?.error?.message || null,
        });
      }

      return response(200, {
        connected: true,
        environment,
        balanceCents: Number(payload.balance ?? Math.round(Number(payload.balance_dollars || 0) * 100)),
        balanceDollars: payload.balance_dollars ?? (Number(payload.balance || 0) / 100).toFixed(2),
        portfolioValueCents: Number(payload.portfolio_value ?? 0),
        portfolioValueDollars: (Number(payload.portfolio_value ?? 0) / 100).toFixed(2),
        updatedAt: payload.updated_ts || null,
        // Kalshi's trading balance endpoint does not return a member display name.
        accountNameAvailable: false,
      });
    } catch (error) {
      context.error('Kalshi account proxy error: ' + error.message);
      return response(500, { error: error.message || 'Kalshi account request failed.' });
    }
  },
});
