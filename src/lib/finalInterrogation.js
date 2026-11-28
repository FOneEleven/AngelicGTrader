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
  const marketStatus = String(market.marketStatus || market.status || '').toLowerCase();
  if (['closed', 'settled', 'final', 'inactive', 'suspended', 'cancelled', 'canceled'].includes(marketStatus)) {
    throw new Error('Market is no longer tradable (' + marketStatus + ').');
  }

  // One eligible matchup review is shared by every rung and side in this ladder.
  // Contract price, line, side, and baseline probability are deliberately excluded:
  // each rung keeps its own baseline probability and executable-price checks.
  const cacheInput = {
    league: market.league || candidate.league || teamStats.league || '',
    team: market.team || candidate.team || teamStats.name || '',
    opponent: market.opponent || candidate.opponent || opponentStats.name || '',
    eventStart,
    eventId: market.eventId || market.eventTicker || market.eventName || '',
    teamStats, opponentStats, pieceInstruction, season,
  };
  const applyCandidatePerspective = (review) => {
    const yesAdjustment = Number(review?.interrogation?.motivationAdjustmentPoints) || 0;
    const isNflNo = String(market.league || candidate.league || '').toUpperCase() === 'NFL' && String(candidate.side || '').toUpperCase() === 'NO';
    const displayedAdjustment = isNflNo ? -yesAdjustment : yesAdjustment;
    const baseProbabilityYes = Number(baselinePrediction?.probabilityYes);
    if (!Number.isFinite(baseProbabilityYes) || baseProbabilityYes < 0 || baseProbabilityYes > 1) {
      throw new Error('Candidate baseline probability is invalid; cached matchup review cannot be applied.');
    }
    // The server's adjustment is expressed against YES probability. For NFL NO,
    // expose the exact inverse as a positive defensive-weather/motivation benefit;
    // the YES probability itself remains base YES plus the server adjustment.
    const probabilityYes = Math.max(0, Math.min(1, baseProbabilityYes + yesAdjustment / 100));
    const assessment = String(review.interrogation.motivationAssessment || '');
    return {
      ...review,
      interrogation: {
        ...review.interrogation,
        baseProbabilityYes,
        probabilityYes,
        motivationAdjustmentPoints: displayedAdjustment,
        motivationAssessment: assessment + (isNflNo ? ' NFL NO perspective: inverted adjustment=' + (displayedAdjustment > 0 ? '+' : '') + displayedAdjustment + ' pp.' : ''),
      },
      audit: review.audit ? { ...review.audit, baseProbabilityYes, finalProbabilityYes: probabilityYes, yesProbabilityAdjustmentPoints: yesAdjustment, sideMotivationAdjustmentPoints: displayedAdjustment } : review.audit,
    };
  };
  if (root) {
    const cached = await getCachedFinalInterrogation(root, cacheInput).catch(() => null);
    if (cached?.verdict === 'KEEP') return { ...applyCandidatePerspective(cached), cacheHit: true };
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
  // Only an eligible KEEP is reusable. Each rung still applies its own baseline,
  // probability floor, and live ask after receiving the shared motivation value.
  if (root && data.verdict === 'KEEP') await setCachedFinalInterrogation(root, cacheInput, data).catch(() => {});
  return applyCandidatePerspective(data);
}
