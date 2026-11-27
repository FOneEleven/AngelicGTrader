import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeason, settleSeasonRound, simulateSeason, aggregateMarketExposure } from '../src/lib/backtesting.js';

test('season keeps original stake after wins and stops after first loss', () => {
  let season = createSeason({ id: 's1', startingStake: 100 });
  season = settleSeasonRound(season, { entryPrice: 0.5, won: true, settledAt: '2026-01-01T00:00:00Z' });
  assert.equal(season.fixedStake, 100);
  assert.equal(season.accumulatedProfit, 100);
  season = settleSeasonRound(season, { entryPrice: 0.5, won: true, settledAt: '2026-01-02T00:00:00Z' });
  assert.equal(season.fixedStake, 100);
  assert.equal(season.accumulatedProfit, 200);
  season = settleSeasonRound(season, { entryPrice: 0.5, won: false, settledAt: '2026-01-03T00:00:00Z' });
  assert.equal(season.status, 'stopped_after_loss');
  assert.equal(season.accumulatedProfit, 100);
  assert.throws(() => settleSeasonRound(season, { entryPrice: 0.5, won: true }), /inactive season/);
});

test('simulation uses chronological qualifying picks and ignores unresolved picks', () => {
  const result = simulateSeason({
    startingStake: 25,
    predictions: [
      { id: 'later', timestamp: '2026-01-03', entryPrice: 0.5, won: true },
      { id: 'unresolved', timestamp: '2026-01-02', entryPrice: 0.5 },
      { id: 'first', timestamp: '2026-01-01', entryPrice: 0.5, won: true },
    ],
  });
  assert.deepEqual(result.rounds.map((r) => r.predictionId), ['first', 'later']);
  assert.equal(result.summary.totalStaked, 50);
});

test('shared market exposure groups allocations without merging owners', () => {
  const [group] = aggregateMarketExposure([
    { marketKey: 'GAME-TOTAL-1', side: 'NO', stake: 100, ownerType: 'season', ownerId: 's1' },
    { marketKey: 'GAME-TOTAL-1', side: 'NO', stake: 50, ownerType: 'independent', ownerId: 'b1' },
  ]);
  assert.equal(group.totalStake, 150);
  assert.equal(group.allocations.length, 2);
});
