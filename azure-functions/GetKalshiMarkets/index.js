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

  const title = m.title || m.yes_sub_title || m.ticker;
  const subtitleCandidate = m.subtitle || m.no_sub_title || '';
  const subtitle = /.+\s+over\s+[\d.]+/i.test(subtitleCandidate) ? subtitleCandidate : title;

  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker || '',
    title,
    // Keep a team-and-threshold label when present; otherwise parse the full market title.
    subtitle,
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


const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const MLB_SCHEDULE = 'https://statsapi.mlb.com/api/v1/schedule';
const normTeam = (value) => String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const teamMatches = (names, target) => {
  const wanted = normTeam(target);
  return !!wanted && (names || []).some((name) => {
    const candidate = normTeam(name);
    return candidate && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
  });
};
function scoreboardEvent(event, league) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1];
  const status = event.status || competition?.status || {};
  const state = String(status.type?.state || '').toLowerCase();
  const statusName = String(status.type?.name || status.type?.description || '').toLowerCase();
  const final = status.type?.completed === true || state === 'post' || statusName.includes('final');
  const live = state === 'in' || statusName.includes('progress') || statusName.includes('halftime');
  const names = (item) => [item?.team?.displayName,item?.team?.shortDisplayName,item?.team?.name,item?.team?.abbreviation,item?.team?.location,item?.team?.nickname].filter(Boolean);
  return { league, eventId: event.id || null, eventName: event.name || event.shortName || '', eventStartTime: event.date || null,
    status: final ? 'FINAL' : live ? 'LIVE' : state === 'pre' ? 'PRE' : 'UNKNOWN',
    homeTeam: names(home), awayTeam: names(away), homeScore: home?.score == null ? null : Number(home.score),
    awayScore: away?.score == null ? null : Number(away.score) };
}
async function fetchScoreEvents(game) {
  const league = String(game.league || '').toUpperCase();
  const start = Date.parse(game.gameTime || game.eventStartTime || '');
  const dates = new Set();
  for (const offset of [-1,0,1]) {
    const date = new Date((Number.isFinite(start) ? start : Date.now()) + offset * 86400000);
    dates.add(date.toISOString().slice(0,10).replace(/-/g,''));
  }
  if (league === 'MLB') {
    const dayDates = [...dates].map((d) => d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8));
    const responses = await Promise.all(dayDates.map(async (date) => {
      const url = new URL(MLB_SCHEDULE); url.searchParams.set('sportId','1'); url.searchParams.set('date',date); url.searchParams.set('hydrate','linescore');
      const response = await fetch(url.toString(), { headers:{Accept:'application/json'} });
      if (!response.ok) throw new Error('MLB scoreboard HTTP '+response.status);
      const data = await response.json();
      return (data.dates || []).flatMap((day) => (day.games || []).map((game) => ({
        league, eventId:String(game.gamePk || ''), eventName:(game.teams?.away?.team?.name || '')+' at '+(game.teams?.home?.team?.name || ''),
        eventStartTime:game.gameDate || null,
        status:/final|completed/i.test(String(game.status?.detailedState || game.status?.abstractGameState || '')) ? 'FINAL' : /live|progress/i.test(String(game.status?.abstractGameState || game.status?.detailedState || '')) ? 'LIVE' : 'PRE',
        homeTeam:[game.teams?.home?.team?.name,game.teams?.home?.team?.clubName,game.teams?.home?.team?.teamName].filter(Boolean),
        awayTeam:[game.teams?.away?.team?.name,game.teams?.away?.team?.clubName,game.teams?.away?.team?.teamName].filter(Boolean),
        homeScore:game.teams?.home?.score == null ? null : Number(game.teams.home.score),
        awayScore:game.teams?.away?.score == null ? null : Number(game.teams.away.score),
      })));
    }));
    return responses.flat();
  }
  const path = league === 'NBA' ? 'basketball/nba' : league === 'NFL' ? 'football/nfl' : null;
  if (!path) throw new Error('Scoreboard league is unsupported: '+league);
  const responses = await Promise.all([...dates].map(async (date) => {
    const url = new URL(ESPN_BASE+'/'+path+'/scoreboard'); url.searchParams.set('dates',date); url.searchParams.set('limit','1000');
    const response = await fetch(url.toString(), { headers:{Accept:'application/json'} });
    if (!response.ok) throw new Error('ESPN scoreboard HTTP '+response.status);
    const data = await response.json();
    return (data.events || []).map((event) => scoreboardEvent(event,league));
  }));
  return responses.flat();
}
async function resolveGameScore(game) {
  const team = String(game.team || '').trim(), opponent = String(game.opponent || '').trim();
  const line = Number(game.line), side = String(game.side || '').toUpperCase();
  if (!team || !opponent || !Number.isFinite(line) || !['YES','NO'].includes(side))
    return { ticker:game.ticker, verified:false, status:'UNKNOWN', error:'Missing team, opponent, numeric line, or YES/NO side.' };
  const events = await fetchScoreEvents(game);
  const matches = events.filter((event) =>
    (teamMatches(event.homeTeam,team) && teamMatches(event.awayTeam,opponent)) ||
    (teamMatches(event.awayTeam,team) && teamMatches(event.homeTeam,opponent)));
  if (matches.length !== 1) return { ticker:game.ticker, verified:false, status:'UNKNOWN', error:matches.length ? 'Multiple scoreboard events matched this matchup.' : 'No exact matchup found on the league scoreboard.', matchesFound:matches.length };
  const event = matches[0], teamIsHome = teamMatches(event.homeTeam,team);
  const teamScore = teamIsHome ? event.homeScore : event.awayScore;
  const opponentScore = teamIsHome ? event.awayScore : event.homeScore;
  if (event.status !== 'FINAL' || !Number.isFinite(teamScore))
    return { ticker:game.ticker, verified:true, status:event.status, event, teamScore, opponentScore, line, side, resolved:false };
  const actualYes = teamScore > line, won = side === 'YES' ? actualYes : !actualYes;
  return { ticker:game.ticker, verified:true, status:'FINAL', event, team, opponent, teamScore, opponentScore, line, side, actualYes, won, resolved:true,
    comparison:teamScore+' '+(actualYes ? '>' : '<=')+' '+line+'; '+side+' '+(won ? 'WON' : 'LOST') };
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
    const requestUrl = new URL(req.url || 'https://localhost/api/GetKalshiMarkets');
    if (requestUrl.searchParams.get('action') === 'score-resolve') {
      let games = [];
      try { games = JSON.parse(requestUrl.searchParams.get('games') || '[]'); } catch {}
      if (!Array.isArray(games) || !games.length) {
        context.res = { status:400, headers:corsHeaders, body:JSON.stringify({error:'Supply game score metadata.'}) };
        return;
      }
      const results = await Promise.all(games.slice(0,50).map(async (game) => {
        try { return await resolveGameScore(game); }
        catch (error) { return { ticker:game?.ticker, verified:false, status:'UNKNOWN', error:error.message || 'Scoreboard lookup failed.' }; }
      }));
      context.res = { status:200, headers:corsHeaders, body:JSON.stringify({results,fetchedAt:new Date().toISOString()}) };
      return;
    }
    if (requestUrl.searchParams.get('action') === 'resolve') {
      const tickers = [...new Set((requestUrl.searchParams.get('tickers') || '').split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 50);
      if (!tickers.length) {
        context.res = { status: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Supply one or more market tickers.' }) };
        return;
      }
      const markets = await Promise.all(tickers.map(async (ticker) => {
        if (!/^[A-Z0-9-]{3,128}$/.test(ticker)) return { ticker, error: 'Invalid ticker.' };
        const response = await fetch(KALSHI_BASE + '/markets/' + encodeURIComponent(ticker), { headers: { Accept: 'application/json' } });
        if (!response.ok) return { ticker, error: 'Market lookup returned HTTP ' + response.status };
        const payload = await response.json();
        const market = payload.market || payload;
        return {
          ticker,
          status: String(market.status || '').toLowerCase(),
          result: String(market.result || '').toLowerCase(),
          settlementValue: market.settlement_value_dollars ?? market.settlement_value ?? null,
          closeTime: market.close_time || '',
          expirationTime: market.expected_expiration_time || '',
        };
      }));
      context.res = { status: 200, headers: corsHeaders, body: JSON.stringify({ markets, fetchedAt: new Date().toISOString() }) };
      return;
    }
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
    await getKalshiMarketsHandler(legacyContext, { method: request.method, url: request.url });
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
