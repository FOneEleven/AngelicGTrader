// Kalshi data via Azure Function proxy.
const BASE = 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/GetKalshiMarkets';

export async function fetchSportsMarkets() {
  const res = await fetch(BASE, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proxy ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return Array.isArray(data.markets) ? data.markets : [];
}

const ACCOUNT_API = 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/KalshiAccount';

export async function submitKalshiOrders(root, orders) {
  if (!root) throw new Error('Local data folder is unavailable.');
  const meta = await root.getDirectoryHandle('meta');
  const file = await meta.getFileHandle('kalshi-connection.json');
  const connection = JSON.parse(await (await file.getFile()).text());
  if (!connection?.keyId || !connection?.envelope) throw new Error('Connect a Kalshi account with trade-write permission before committing live orders.');
  const results = [];
  for (let offset = 0; offset < orders.length; offset += 20) {
    const batch = orders.slice(offset, offset + 20);
    try {
      const response = await fetch(ACCOUNT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action: 'orders', keyId: connection.keyId, envelope: connection.envelope, orders: batch }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.results)) {
        results.push(...batch.map((order) => ({ client_order_id: order.client_order_id, ticker: order.ticker, submitted: false, error: payload.error || 'Kalshi order submission failed with HTTP ' + response.status + '.' })));
      } else {
        results.push(...payload.results);
      }
    } catch (error) {
      results.push(...batch.map((order) => ({ client_order_id: order.client_order_id, ticker: order.ticker, submitted: false, error: error.message || 'Kalshi request failed.' })));
      break;
    }
  }
  return results;
}


export async function fetchMarketResolutions(tickers = []) {
  const unique = [...new Set((tickers || []).filter((ticker) => typeof ticker === 'string' && ticker.trim()))];
  if (!unique.length) return [];
  const results = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const url = new URL(BASE);
    url.searchParams.set('action', 'resolve');
    url.searchParams.set('tickers', unique.slice(offset, offset + 50).join(','));
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error('Market resolution lookup failed with HTTP ' + response.status + '.');
    const payload = await response.json();
    if (Array.isArray(payload.markets)) results.push(...payload.markets);
  }
  return results;
}


export async function fetchGameScoreResolutions(games = []) {
  const unique = (games || []).filter((game) => game?.ticker);
  if (!unique.length) return [];
  const results = [];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const url = new URL(BASE);
    url.searchParams.set('action', 'score-resolve');
    url.searchParams.set('games', JSON.stringify(unique.slice(offset, offset + 20)));
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error('Game score lookup failed with HTTP ' + response.status + '.');
    const payload = await response.json();
    if (Array.isArray(payload.results)) results.push(...payload.results);
  }
  return results;
}

export async function fetchKalshiOrderStatuses(root, orderIds = []) {
  if (!root) throw new Error('Local data folder is unavailable.');
  const unique = [...new Set((orderIds || []).filter((id) => typeof id === 'string' && id.trim()))];
  if (!unique.length) return [];
  const meta = await root.getDirectoryHandle('meta');
  const file = await meta.getFileHandle('kalshi-connection.json');
  const connection = JSON.parse(await (await file.getFile()).text());
  if (!connection?.keyId || !connection?.envelope) throw new Error('Kalshi connection is unavailable for order-fill verification.');
  const orders = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const response = await fetch(ACCOUNT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        action: 'order-status',
        keyId: connection.keyId,
        envelope: connection.envelope,
        orderIds: unique.slice(offset, offset + 50),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.orders)) throw new Error(payload.error || 'Could not verify Kalshi order fills.');
    orders.push(...payload.orders);
  }
  return orders;
}
