import test from 'node:test';
import assert from 'node:assert/strict';
import { computePredictions } from '../src/lib/predictions.js';

function ladder({ occurrenceTime, closeTime, status = 'open' } = {}) {
  const eventTicker = 'KXNBAGAME-2026-TEST';
  return [95, 100, 105, 110, 115, 120].map((line, index) => ({
    ticker: 'KXNBATEAMTOTAL-2026-TEST-BOS-' + line,
    eventTicker,
    title: 'Boston Celtics over ' + line,
    subtitle: 'Boston Celtics over ' + line,
    status,
    occurrenceTime: occurrenceTime || '',
    expectedExpiration: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    closeTime: closeTime || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    yesAsk: [0.62, 0.55, 0.45, 0.35, 0.25, 0.15][index],
    noAsk: [0.38, 0.45, 0.55, 0.65, 0.75, 0.85][index],
    openInterest: 100,
    volume24h: 50,
  }));
}

test('pregame eligibility requires an explicit future occurrenceTime', () => {
  const missing = computePredictions(ladder()).predictions;
  const started = computePredictions(ladder({
    occurrenceTime: new Date(Date.now() - 60_000).toISOString(),
  })).predictions;
  assert.equal(missing.length, 0, 'missing event start must fail closed');
  assert.equal(started.length, 0, 'started contest must be excluded');
});

test('pregame eligibility rejects closed markets even if the event is in the future', () => {
  const predictions = computePredictions(ladder({
    occurrenceTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    closeTime: new Date(Date.now() - 60_000).toISOString(),
  })).predictions;
  assert.equal(predictions.length, 0);
});

test('pregame eligibility accepts an open market with a future occurrenceTime', () => {
  const predictions = computePredictions(ladder({
    occurrenceTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })).predictions;
  assert.ok(predictions.length > 0);
  assert.ok(predictions.every((item) => item.occurrenceTime));
});
