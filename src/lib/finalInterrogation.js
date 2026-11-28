// Browser client for the Azure FinalInterrogation function.
import { getCachedFinalInterrogation, setCachedFinalInterrogation } from './finalInterrogationCache';
const BASE = import.meta.env.VITE_FINAL_INTERROGATION_URL
  || 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/FinalInterrogation';

export async function finalInterrogateCandidate({ candidate, market, teamStats, opponentStats, baselinePrediction, pieceInstruction, season, root }) {
  if (!candidate || !market || !teamStats || !opponentStats) {
    throw new Error('candidate, market, teamStats, and opponentStats are required');
  }
  // The event occurrence timestamp is kickoff/tipoff/first pitch. Never
  // substitute Kalshi closeTime or expectedExpiration for the event start.
  const eventStart = market.occurrenceTime || market.gameTime;
  const eventStartMs = eventStart ? Date.parse(eventStart) : NaN;
  if (!Number.isFinite(eventStartMs)) throw new Error('Pregame check failed: official event start time is missing.');
  if (eventStartMs <= Date.now()) throw new Error('Pregame check failed: contest has already started.');
  const marketCloseMs = market.closeTime ? Date.parse(market.closeTime) : NaN;
  if (Number.isFinite(marketCloseMs) && marketCloseMs <= Date.now()) {
    throw new Error('Market is already closed; no new position can be evaluated.');
  }
  // Validate kickoff and market-open status above before allowing a cached review.
  const cacheInput = { candidate, market, teamStats, opponentStats, baselinePrediction, pieceInstruction, season };
  if (root) {
    const cached = await getCachedFinalInterrogation(root, cacheInput).catch(() => null);
    if (cached) return { ...cached, cacheHit: true };
  }
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate, market, teamStats, opponentStats, baselinePrediction, pieceInstruction, season,
      interrogationPolicy: {
        motivationBonusPercentagePoints: 4,
        highProfileLowStakesPenaltyPercentagePoints: -6,
        preferredOpponentPercentile: { min: 10, max: 40, scale: '0=weakest, 100=strongest' },
        objective: 'serious competitive games with strong fantasy upside',
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'FinalInterrogation failed (' + response.status + ')');
  if (!data.interrogation || !['KEEP', 'REJECT', 'REVIEW'].includes(data.verdict)) {
    throw new Error('FinalInterrogation returned an invalid review');
  }
  if (root) await setCachedFinalInterrogation(root, cacheInput, data).catch(() => {});
  return data;
}
