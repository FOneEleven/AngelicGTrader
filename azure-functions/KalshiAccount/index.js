// Kalshi account proxy. Credentials are decrypted and used only in memory.
// DEBUG BUILD: returns a stage identifier and logs stack traces without logging secrets.
// Azure settings:
// KALSHI_ENCRYPTION_PRIVATE_KEY = matching RSA private key (PEM)
// KALSHI_ENCRYPTION_PUBLIC_KEY  = matching RSA public key (PEM)
// KALSHI_ENVIRONMENT            = production (default) or demo
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

function normalizePem(value, settingName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(settingName + ' is missing.');
  }
  const pem = value.trim().replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  if (!pem.includes('-----BEGIN ') || !pem.includes('-----END ')) {
    throw new Error(settingName + ' is not a complete PEM key. Include the BEGIN/END lines.');
  }
  return pem;
}

function decryptCredential(envelope, setStage) {
  setStage('parse Azure RSA private key');
  let rsaPrivateKey;
  try {
    const pem = normalizePem(process.env.KALSHI_ENCRYPTION_PRIVATE_KEY, 'KALSHI_ENCRYPTION_PRIVATE_KEY');
    rsaPrivateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
    if (rsaPrivateKey.asymmetricKeyType !== 'rsa' && rsaPrivateKey.asymmetricKeyType !== 'rsa-pss') {
      throw new Error('Expected an RSA private key; received ' + rsaPrivateKey.asymmetricKeyType + '.');
    }
  } catch (error) {
    error.message = 'Azure RSA private-key configuration is invalid: ' + error.message;
    throw error;
  }

  setStage('validate encrypted credential envelope');
  const encryptedKey = Buffer.from(envelope.encryptedKey, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (!encryptedKey.length || iv.length !== 12 || ciphertext.length < 17) {
    throw new Error('Encrypted credential envelope is malformed.');
  }

  setStage('unwrap AES encryption key with Azure RSA key');
  let aesKey;
  try {
    aesKey = crypto.privateDecrypt({
      key: rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, encryptedKey);
  } catch (error) {
    error.message = 'RSA-OAEP key unwrap failed: ' + error.message;
    throw error;
  }
  if (aesKey.length !== 32) {
    aesKey.fill(0);
    throw new Error('Decrypted AES key has an invalid length.');
  }

  try {
    setStage('decrypt Kalshi signing-key PEM with AES-256-GCM');
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return normalizePem(plaintext, 'Decrypted Kalshi signing key');
  } catch (error) {
    error.message = 'AES-GCM signing-key decryption failed: ' + error.message;
    throw error;
  } finally {
    aesKey.fill(0);
  }
}

function signRequest(keyId, privatePem, method, path, setStage) {
  setStage('parse decrypted Kalshi Ed25519 signing key');
  let signingKey;
  try {
    signingKey = crypto.createPrivateKey({ key: privatePem, format: 'pem' });
  } catch (error) {
    error.message = 'Decrypted Kalshi signing key PEM parse failed: ' + error.message;
    throw error;
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Kalshi signing key must be Ed25519; received ' + signingKey.asymmetricKeyType + '.');
  }

  setStage('sign Kalshi balance request');
  const timestamp = String(Date.now());
  const message = Buffer.from(timestamp + method.toUpperCase() + path.split('?')[0], 'utf8');
  const signature = crypto.sign(null, message, signingKey);
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

    let stage = 'initialize request';
    const setStage = (value) => { stage = value; };

    try {
      if (request.method === 'GET') {
        stage = 'load Azure RSA public key';
        if (request.query.get('action') !== 'publicKey') {
          return response(400, { error: 'Use ?action=publicKey.' });
        }
        const publicKey = normalizePem(process.env.KALSHI_ENCRYPTION_PUBLIC_KEY, 'KALSHI_ENCRYPTION_PUBLIC_KEY');
        return response(200, { publicKey });
      }

      stage = 'parse POST body';
      const body = await request.json();
      const keyId = String(body?.keyId || '').trim();
      if (!keyId || keyId.length > 128) return response(400, { error: 'A valid Kalshi API Key ID is required.' });
      if (!body?.envelope?.encryptedKey || !body?.envelope?.iv || !body?.envelope?.ciphertext) {
        return response(400, { error: 'Encrypted credential envelope is incomplete.' });
      }

      const signingPem = decryptCredential(body.envelope, setStage);
      setStage('select Kalshi environment and account endpoint');
      const environment = process.env.KALSHI_ENVIRONMENT === 'demo' ? 'demo' : 'production';
      const host = HOSTS[environment];
      if (body.action === 'history') {
        const allPages = [];
        const allFills = [];
        let truncated = false;
        for (const endpoint of ['/portfolio/fills', '/historical/fills']) {
          let cursor = '';
          let pageCount = 0;
          do {
            const query = new URLSearchParams({ limit: '1000' });
            if (cursor) query.set('cursor', cursor);
            const requestPath = PREFIX + endpoint + '?' + query.toString();
            const headers = signRequest(keyId, signingPem, 'GET', requestPath, setStage);
            setStage('retrieve Kalshi fills ' + endpoint);
            const upstream = await fetch(host + requestPath, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
            const payload = await upstream.json().catch(() => ({}));
            if (!upstream.ok) return response(upstream.status === 401 ? 401 : 502, { error: 'Kalshi history request failed.', endpoint, kalshiStatus: upstream.status, detail: payload?.error?.details || payload?.error?.message || null });
            const fills = Array.isArray(payload.fills) ? payload.fills : [];
            allFills.push(...fills);
            allPages.push({ endpoint, response: payload });
            cursor = payload.cursor || '';
            pageCount += 1;
          } while (cursor && pageCount < 50);
          if (cursor) truncated = true;
        }
        const unique = new Map();
        for (const fill of allFills) unique.set(String(fill.fill_id || fill.trade_id || fill.id || JSON.stringify(fill)), fill);
        return response(200, { connected: true, environment, fills: Array.from(unique.values()), apiResponses: allPages, truncated });
      }
      const path = PREFIX + '/portfolio/balance';
      const headers = signRequest(keyId, signingPem, 'GET', path, setStage);

      setStage('send signed request to Kalshi');
      const upstream = await fetch(host + path, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });

      setStage('read Kalshi balance response');
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        context.warn('Kalshi balance request failed with HTTP ' + upstream.status);
        return response(upstream.status === 401 ? 401 : 502, {
          error: 'Kalshi account verification failed.',
          stage,
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
      });
    } catch (error) {
      const diagnostic = {
        error: error.message || 'Kalshi account request failed.',
        stage,
        errorCode: error.code || error.library || null,
        stack: error.stack || null,
      };
      context.error('KalshiAccount DEBUG failure: ' + JSON.stringify(diagnostic));
      return response(500, diagnostic);
    }
  },
});
