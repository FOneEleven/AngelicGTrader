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