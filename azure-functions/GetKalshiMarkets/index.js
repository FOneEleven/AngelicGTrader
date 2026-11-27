// Azure Function (v4 model): Kalshi proxy for AngelicGTrader
// Team-total markets, NFL first, MLB early-run markets included.

const { app } = require('@azure/functions');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const PRIORITY_SERIES = [
  'KXNFLTEAMTOTAL',
  'KXMLBTEAMTOTAL',
  'KXNBATEAMTOTAL',
  'KXNCAMBT',
];

async function fetchSeries(seriesTicker) {
  const url = new URL(`${KALSHI_BASE}/markets`);
  url.searchParams.set('series_ticker', seriesTicker);
  url.searchParams.set('status', 'open');
  url.searchParams.set('limit', '1000');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) return [];

  const data = await res.json();
  return Array.isArray(data.markets) ? data.markets : [];
}

function leagueOf(ticker = '') {
  const m = ticker.match(/^KX([A-Z0-9]+?)TEAMTOTAL-/);
  return m ? m[1] : 'OTHER';
}

function normalizeMarket(m) {
  const num = (v) => {
    if (v == null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker || '',
    title: m.title || m.yes_sub_title || m.ticker,
    // Kalshi team-total YES subtitle identifies the team and run/point threshold.
    subtitle: m.subtitle || m.yes_sub_title || m.no_sub_title || '',
    status: m.status || '',
    closeTime: m.close_time || '',
    expectedExpiration: m.expected_expiration_time || '',
    occurrenceTime: m.occurrence_datetime || '',
    latestExpiration: m.latest_expiration_time || '',
    openInterest: num(m.open_interest_fp ?? m.open_interest),
    volume24h: num(m.volume_24h_fp ?? m.volume_24h),
    volume: num(m.volume_fp ?? m.volume),
    yesBid: num(m.yes_bid_dollars ?? m.yes_bid),
    yesAsk: num(m.yes_ask_dollars ?? m.yes_ask),
    noBid: num(m.no_bid_dollars ?? m.no_bid),
    noAsk: num(m.no_ask_dollars ?? m.no_ask),
    lastPrice: num(m.last_price_dollars ?? m.last_price),
    floorStrike: m.floor_strike ?? null,
    league: leagueOf(m.ticker || ''),
  };
}

async function getKalshiMarketsHandler(context, req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: corsHeaders, body: '' };
    return;
  }

  try {
    const started = Date.now();
    const raw = [];

    for (const series of PRIORITY_SERIES) {
      try {
        const markets = await fetchSeries(series);
        raw.push(...markets.map((m) => ({ m, _series: series })));
      } catch (e) {
        context.log.warn(`Series ${series} failed: ${e.message}`);
      }
    }

    const normalized = raw.map(({ m, _series }) => {
      const market = normalizeMarket(m);
      market.priority = _series === 'KXNFLTEAMTOTAL' ? 0
        : _series === 'KXMLBTEAMTOTAL' ? 1
        : _series === 'KXNBATEAMTOTAL' ? 2 : 3;
      return market;
    });

    normalized.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.openInterest - a.openInterest;
    });

    context.res = {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        nonce: Math.floor(Math.random() * 1e9),
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        count: normalized.length,
        byLeague: normalized.reduce((acc, market) => {
          acc[market.league] = (acc[market.league] || 0) + 1;
          return acc;
        }, {}),
        markets: normalized,
      }),
    };
  } catch (e) {
    context.log.error('Kalshi proxy failed:', e.message);
    context.res = {
      status: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: e.message || 'Kalshi fetch failed' }),
    };
  }
}

app.http('GetKalshiMarkets', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const legacyLog = (...args) => context.log(...args);
    legacyLog.warn = (...args) => context.warn(...args);
    legacyLog.error = (...args) => context.error(...args);

    const legacyContext = { log: legacyLog, res: null };
    await getKalshiMarketsHandler(legacyContext, { method: request.method });
    const result = legacyContext.res;

    if (!result) {
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Function completed without an HTTP response.' }),
      };
    }

    return { status: result.status, headers: result.headers, body: result.body };
  },
});
