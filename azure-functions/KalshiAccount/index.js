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
  // Azure App Settings may preserve a BOM, surrounding quotes, escaped newlines,
  // or platform-specific line endings. Normalize only the PEM container formatting;
  // never alter the key material itself.
  let pem = value.replace(/^\\uFEFF/, '').trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1).trim();
  }
  pem = pem
    .replace(/\\\\r\\\\n/g, '\n')
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\n')
    .replace(/\\r\\n?/g, '\n')
    .trim();
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

  setStage('sign Kalshi API request');
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
      if (body.action === 'orders') {
        const orders = Array.isArray(body.orders) ? body.orders : [];
        if (!orders.length || orders.length > 20) {
          return response(400, { error: 'Provide between 1 and 20 validated order requests.' });
        }
        const results = [];
        for (const order of orders) {
          const ticker = String(order?.ticker || '').trim();
          const side = String(order?.side || '').toLowerCase();
          const count = String(order?.count || '');
          const price = String(order?.price || '');
          const clientOrderId = String(order?.client_order_id || '');
          if (!ticker || !['bid', 'ask'].includes(side) || !/^\d+(?:\.\d{1,2})?$/.test(count) || !(Number(count) >= 0.01) || !/^0?\.\d{1,4}$/.test(price) || !(Number(price) > 0 && Number(price) < 1) || !/^[A-Za-z0-9_+=-]{1,64}$/.test(clientOrderId)) {
            results.push({ client_order_id: clientOrderId || null, ticker, submitted: false, error: 'Invalid V2 order fields.' });
            continue;
          }
          const requestPath = PREFIX + '/portfolio/events/orders';
          const headers = { ...signRequest(keyId, signingPem, 'POST', requestPath, setStage), 'Content-Type': 'application/json' };
          const requestBody = {
            ticker, client_order_id: clientOrderId, side, count, price,
            time_in_force: 'good_till_canceled',
            self_trade_prevention_type: 'taker_at_cross',
            post_only: false, cancel_order_on_pause: false, reduce_only: false,
            exchange_index: -1,
          };
          setStage('submit Kalshi V2 order for ' + ticker);
          const upstream = await fetch(host + requestPath, {
            method: 'POST', headers, body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(20000),
          });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok) {
            results.push({
              client_order_id: clientOrderId, ticker, submitted: false,
              kalshiStatus: upstream.status,
              error: payload?.error?.message || payload?.error?.details || 'Kalshi rejected the order.',
            });
            continue;
          }
          results.push({
            client_order_id: clientOrderId, ticker, submitted: true,
            order_id: payload.order_id || payload.order?.order_id || null,
            fill_count: payload.fill_count ?? payload.order?.fill_count ?? '0.00',
            remaining_count: payload.remaining_count ?? payload.order?.remaining_count ?? null,
            ts_ms: payload.ts_ms || Date.now(),
            response: payload,
          });
        }
        return response(200, {
          connected: true, environment,
          submitted: results.filter((item) => item.submitted).length,
          failed: results.filter((item) => !item.submitted).length,
          results,
        });
      }

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
      if (body.action === 'order-status') {
        const orderIds = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 50);
        if (!orderIds.length) return response(400, { error: 'Provide one or more Kalshi order IDs.' });
        const orders = await Promise.all(orderIds.map(async (orderId) => {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) return { orderId, error: 'Invalid order ID.' };
          const requestPath = PREFIX + '/portfolio/orders/' + encodeURIComponent(orderId);
          const headers = signRequest(keyId, signingPem, 'GET', requestPath, setStage);
          setStage('retrieve Kalshi order status ' + orderId);
          const upstream = await fetch(host + requestPath, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok) return { orderId, error: payload?.error?.message || 'Kalshi order lookup returned HTTP ' + upstream.status };
          const order = payload.order || payload;
          return {
            orderId,
            ticker: order.ticker || '',
            status: order.status || '',
            fill_count: order.fill_count ?? order.fill_count_fp ?? '0.00',
            remaining_count: order.remaining_count ?? order.remaining_count_fp ?? null,
          };
        }));
        return response(200, { connected: true, environment, orders });
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
      context.error('KalshiAccount failure at ' + stage + ': ' + (error.message || 'Unknown error'));
      return response(500, { error: 'Kalshi account request failed.', stage });
    }
  },
});
