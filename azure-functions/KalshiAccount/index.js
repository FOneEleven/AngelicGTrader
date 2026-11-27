// Kalshi account proxy. Credentials are decrypted and used only in memory.
// Azure settings:
// KALSHI_ENCRYPTION_PRIVATE_KEY = matching RSA private key (PEM)
// KALSHI_ENCRYPTION_PUBLIC_KEY  = matching RSA public key (PEM; GET tutorial only)
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

// Azure App Settings sometimes store PEM line breaks as literal "\\n".
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

function decryptCredential(envelope) {
  // Parse the RSA key separately so PEM/configuration failures are distinguishable
  // from envelope/decryption failures.
  let rsaPrivateKey;
  try {
    const pem = normalizePem(process.env.KALSHI_ENCRYPTION_PRIVATE_KEY, 'KALSHI_ENCRYPTION_PRIVATE_KEY');
    rsaPrivateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
    if (rsaPrivateKey.asymmetricKeyType !== 'rsa' && rsaPrivateKey.asymmetricKeyType !== 'rsa-pss') {
      throw new Error('Expected an RSA private key.');
    }
  } catch (error) {
    throw new Error('Azure RSA private-key configuration is invalid: ' + error.message);
  }

  const encryptedKey = Buffer.from(envelope.encryptedKey, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (!encryptedKey.length || iv.length !== 12 || ciphertext.length < 17) {
    throw new Error('Encrypted credential envelope is malformed.');
  }

  let aesKey;
  try {
    aesKey = crypto.privateDecrypt({
      key: rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, encryptedKey);
  } catch {
    throw new Error('Could not unwrap the encrypted credential. The browser public key and Azure RSA private key do not match, or the envelope is invalid.');
  }
  if (aesKey.length !== 32) throw new Error('Decrypted AES key has an invalid length.');

  try {
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return normalizePem(plaintext, 'Decrypted Kalshi signing key');
  } catch (error) {
    throw new Error('Could not decrypt the Kalshi signing key. Check that the browser and Azure encryption keys match. ' + error.message);
  } finally {
    aesKey.fill(0);
  }
}

function signRequest(keyId, privatePem, method, path) {
  let signingKey;
  try {
    signingKey = crypto.createPrivateKey({ key: privatePem, format: 'pem' });
  } catch (error) {
    throw new Error('The decrypted Kalshi signing key is not a valid PEM private key: ' + error.message);
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The Kalshi signing key must be Ed25519; received ' + signingKey.asymmetricKeyType + '.');
  }

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
    try {
      if (request.method === 'GET') {
        if (request.query.get('action') !== 'publicKey') {
          return response(400, { error: 'Use ?action=publicKey.' });
        }
        const publicKey = normalizePem(process.env.KALSHI_ENCRYPTION_PUBLIC_KEY, 'KALSHI_ENCRYPTION_PUBLIC_KEY');
        return response(200, { publicKey });
      }

      const body = await request.json();
      const keyId = String(body?.keyId || '').trim();
      if (!keyId || keyId.length > 128) return response(400, { error: 'A valid Kalshi API Key ID is required.' });
      if (!body?.envelope?.encryptedKey || !body?.envelope?.iv || !body?.envelope?.ciphertext) {
        return response(400, { error: 'Encrypted credential envelope is incomplete.' });
      }

      const signingPem = decryptCredential(body.envelope);
      const environment = process.env.KALSHI_ENVIRONMENT === 'demo' ? 'demo' : 'production';
      const path = PREFIX + '/portfolio/balance';
      const headers = signRequest(keyId, signingPem, 'GET', path);
      const upstream = await fetch(HOSTS[environment] + path, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });
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
        accountNameAvailable: false,
      });
    } catch (error) {
      context.error('Kalshi account proxy error: ' + error.message);
      return response(500, { error: error.message || 'Kalshi account request failed.' });
    }
  },
});
