// Fixed-stake season and independent-bet backtesting.
// Each season round risks the original fixed stake. Winnings/profits are tracked
// separately and are never rolled into the next round. A season stops on first loss.

export const BACKTEST_VERSION = 'season-backtest-1.0.0';

const numberOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function createSeason({
  id, name, sport = 'ALL', startingStake, currency = 'USD',
  createdAt = new Date().toISOString(),
}) {
  const stake = numberOr(startingStake, NaN);
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error('Season startingStake must be greater than zero.');
  }
  return {
    id: id || 'season-' + Date.now(),
    name: name || 'Untitled season',
    sport, currency, startingStake: stake, fixedStake: stake,
    accumulatedProfit: 0, wins: 0, losses: 0, rounds: [],
    status: 'active', createdAt, endedAt: null, version: BACKTEST_VERSION,
  };
}

/** Settle one round. The stake remains fixed regardless of prior wins. */
export function settleSeasonRound(season, {
  predictionId, marketKey, league, matchup, side, entryPrice, won,
  fee = 0, settledAt = new Date().toISOString(), resultSource = null,
}) {
  if (!season || season.status !== 'active') {
    throw new Error('Cannot settle a round for an inactive season.');
  }
  if (typeof won !== 'boolean') {
    throw new Error('A verified boolean outcome is required to settle a round.');
  }
  const price = numberOr(entryPrice, NaN);
  if (!(price > 0 && price < 1)) {
    throw new Error('entryPrice must be greater than 0 and less than 1.');
  }

  const stake = season.fixedStake;
  const fees = Math.max(0, numberOr(fee));
  const grossProfit = won ? stake * ((1 - price) / price) : -stake;
  const netProfit = grossProfit - fees;
  const round = {
    roundNumber: season.rounds.length + 1,
    predictionId: predictionId || null,
    marketKey: marketKey || null,
    league: league || null,
    matchup: matchup || null,
    side: side || null,
    stake,
    entryPrice: price,
    fee: fees,
    won,
    grossProfit: Number(grossProfit.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    settledAt,
    resultSource,
  };

  const next = {
    ...season,
    rounds: [...season.rounds, round],
    accumulatedProfit: Number((season.accumulatedProfit + netProfit).toFixed(2)),
    wins: season.wins + (won ? 1 : 0),
    losses: season.losses + (won ? 0 : 1),
  };
  if (!won) {
    next.status = 'stopped_after_loss';
    next.endedAt = settledAt;
  }
  return next;
}

/** Replay settled predictions in chronological order; first loss ends the season. */
export function simulateSeason({
  season, predictions, startingStake, feePerContract = 0,
}) {
  let state = season || createSeason({ startingStake });
  const ordered = [...(predictions || [])].sort((a, b) =>
    new Date(a.scheduledAt || a.timestamp || 0) - new Date(b.scheduledAt || b.timestamp || 0)
  );

  for (const prediction of ordered) {
    if (state.status !== 'active') break;
    if (prediction.qualified === false || typeof prediction.won !== 'boolean') continue;
    const price = numberOr(prediction.entryPrice, NaN);
    if (!(price > 0 && price < 1)) continue;
    state = settleSeasonRound(state, {
      predictionId: prediction.id,
      marketKey: prediction.marketKey || prediction.ticker,
      league: prediction.league,
      matchup: prediction.matchup,
      side: prediction.side,
      entryPrice: price,
      won: prediction.won,
      fee: prediction.fee ?? feePerContract,
      settledAt: prediction.settledAt || prediction.timestamp,
      resultSource: prediction.resultSource || null,
    });
  }

  return {
    ...state,
    summary: {
      roundsPlayed: state.rounds.length,
      wins: state.wins,
      losses: state.losses,
      fixedStake: state.fixedStake,
      totalStaked: Number((state.rounds.length * state.fixedStake).toFixed(2)),
      accumulatedProfit: state.accumulatedProfit,
      status: state.status,
      winRate: state.rounds.length ? Number((state.wins / state.rounds.length).toFixed(4)) : null,
    },
  };
}

/**
 * Group shared market exposure without merging independent allocation records.
 * Each season or independent bet retains its own identity and settlement.
 */
export function aggregateMarketExposure(positions = []) {
  const grouped = new Map();
  for (const position of positions) {
    if (!position.marketKey || !position.side) continue;
    const key = position.marketKey + '::' + position.side;
    const current = grouped.get(key) || {
      marketKey: position.marketKey, side: position.side,
      totalStake: 0, allocations: [],
    };
    const stake = Math.max(0, numberOr(position.stake));
    current.totalStake += stake;
    current.allocations.push({
      ownerType: position.ownerType || 'independent',
      ownerId: position.ownerId || position.id || null,
      stake, status: position.status || 'open',
    });
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({
    ...item, totalStake: Number(item.totalStake.toFixed(2)),
  }));
}
