// AngelicGTrader — two-pass team-total strategy.
//   Pass 1 (cliff): walk up from the 50% anchor; first step >= strongDelta wins.
//   Pass 2 (midpoint): for ladders with no cliff, back off `midBackOff` lines
//                      from the midpoint of the ladder.
// Close window uses `expectedExpiration` (resolution time), with a fallback to
// `closeTime` for old cache rows. Payout band is flagged, not filtered.

const TEAM_TOTAL = /^KX([A-Z0-9]+?)TEAMTOTAL-/;

export const DEFAULTS = {
  anchorTarget: 0.50,
  weakDelta: 0.10,
  strongDelta: 0.16,
  backOffSteps: 5,
  midBackOff: 3,
  minMidLadder: 6,
  maxHoursToClose: 48,
};

function leagueOf(ticker = '') {
  const m = ticker.match(TEAM_TOTAL);
  return m ? m[1] : null;
}
function teamName(subtitle = '') {
  const m = subtitle.match(/^(.+?)\s+over\s+/i);
  return m ? m[1].trim() : subtitle;
}
function parseLine(subtitle = '') {
  const m = subtitle.match(/over\s+([\d.]+)/i);
  return m ? Number(m[1]) : null;
}

// Prefer expected_expiration_time; fall back to close_time for legacy cache rows.
function resolveGameTime(m) {
  return m.expectedExpiration || m.closeTime || '';
}

export function computePredictions(markets, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = Date.now();
  const closeCutoff = now + cfg.maxHoursToClose * 3_600_000;

  const teamTotals = markets.filter((m) => {
    if (!TEAM_TOTAL.test(m.ticker || '')) return false;
    const status = String(m.status || '').toLowerCase();
    if (['closed', 'settled', 'finalized', 'resolved'].includes(status) || m.isClosed === true) return false;
    const closeAt = m.expectedExpiration || m.closeTime;
    if (closeAt) { const closeMs = new Date(closeAt).getTime(); if (Number.isFinite(closeMs) && closeMs <= now) return false; }
    return true;
  });

  const ladders = new Map();
  for (const m of teamTotals) {
    const line = parseLine(m.subtitle || m.title || '');
    if (line == null) continue;
    const team = teamName(m.subtitle || m.title || '');
    const event = m.eventTicker || m.ticker;
    const key = `${event}::${team}`;
    if (!ladders.has(key)) {
      ladders.set(key, {
        key, event, team,
        league: leagueOf(m.ticker),
        closeTime: m.closeTime,
        expectedExpiration: m.expectedExpiration,
        gameTime: resolveGameTime(m),
        lines: [],
      });
    }
    ladders.get(key).lines.push({
      ticker: m.ticker,
      line,
      yesAsk: m.yesAsk,
      yesBid: m.yesBid,
      noAsk: m.noAsk ?? (m.yesBid == null ? null : 1 - m.yesBid),
      noBid: m.noBid ?? (m.yesAsk == null ? null : 1 - m.yesAsk),
      openInterest: m.openInterest,
      volume24h: m.volume24h,
    });
  }

  const cliffRows = [];
  const midRows = [];
  const diagnostics = [];

  for (const ladder of ladders.values()) {
    ladder.lines.sort((a, b) => a.line - b.line);
    const lines = ladder.lines;

    if (lines.length < 2) {
      diagnostics.push({ ...ladder, reason: 'ladder too short', steps: [], anchorIdx: 0 });
      continue;
    }

    let anchorIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const p = lines[i].yesAsk;
      if (p == null) continue;
      const d = Math.abs(p - cfg.anchorTarget);
      if (d < bestDist) { bestDist = d; anchorIdx = i; }
    }

    const steps = [];
    let strongIdx = -1;
    let strongDelta = null;
    for (let i = anchorIdx; i < lines.length - 1; i++) {
      const a = lines[i].yesAsk;
      const b = lines[i + 1].yesAsk;
      if (a == null || b == null) continue;
      const delta = a - b;
      steps.push({ from: i, to: i + 1, delta });
      if (delta >= cfg.strongDelta) { strongIdx = i + 1; strongDelta = delta; break; }
    }

    const gtMs = ladder.gameTime ? new Date(ladder.gameTime).getTime() : NaN;
    const withinWindow = Number.isFinite(gtMs) && gtMs > now && gtMs <= closeCutoff;

    if (strongIdx !== -1) {
      const targetIdx = Math.max(0, strongIdx - cfg.backOffSteps);
      const target = lines[targetIdx];
      if (target && target.yesAsk != null) {
        const payout = 1 / target.yesAsk;
        cliffRows.push({
          ...ladder,
          strategy: 'cliff',
          anchorIdx, strongIdx, targetIdx,
          anchor: lines[anchorIdx],
          strong: lines[strongIdx],
          recommended: target,
          strongDelta,
          backOffSteps: cfg.backOffSteps,
          payout,
          withinWindow,
          flags: withinWindow ? [] : ['outside close window'],
          steps,
        });
        continue;
      }
    }

    if (lines.length < cfg.minMidLadder) {
      diagnostics.push({ ...ladder, reason: `no cliff · ladder < ${cfg.minMidLadder} for midpoint`, steps, anchorIdx });
      continue;
    }

    const midIdx = Math.floor((lines.length - 1) / 2);
    const targetIdx = Math.max(0, midIdx - cfg.midBackOff);
    const target = lines[targetIdx];
    if (!target || target.yesAsk == null) {
      diagnostics.push({ ...ladder, reason: 'midpoint target unpriceable', steps, anchorIdx });
      continue;
    }

    const payout = 1 / target.yesAsk;
    midRows.push({
      ...ladder,
      strategy: 'midpoint',
      anchorIdx, midIdx, targetIdx,
      anchor: lines[anchorIdx],
      mid: lines[midIdx],
      recommended: target,
      midBackOff: cfg.midBackOff,
      payout,
      withinWindow,
      flags: withinWindow ? [] : ['outside close window'],
      steps,
    });
  }

  const sortWithin = (rows) => rows.sort((a, b) => {
    const priority = (league) => league === 'NFL' ? 0 : league === 'MLB' ? 1 : league === 'NBA' ? 2 : 3;
    const aNfl = priority(a.league), bNfl = priority(b.league);
    if (aNfl !== bNfl) return aNfl - bNfl;
    return b.payout - a.payout;
  });
  sortWithin(cliffRows);
  sortWithin(midRows);

  return {
    predictions: [...cliffRows, ...midRows],
    cliffCount: cliffRows.length,
    midCount: midRows.length,
    diagnostics,
  };
}