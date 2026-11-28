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
    const response = await fetch(ACCOUNT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: 'orders', keyId: connection.keyId, envelope: connection.envelope, orders: batch }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.results)) {
      throw new Error(payload.error || 'Kalshi order submission failed with HTTP ' + response.status + '.');
    }
    results.push(...payload.results);
  }
  return results;
}
