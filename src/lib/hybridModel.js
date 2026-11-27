// Hybrid prediction engine: quantitative baseline + explicit contextual adjustments.
// This module is deterministic and auditable. It does not invent missing team data.
// AI-researched context should be normalized into the context object before scoring.

export const MODEL_VERSION = 'hybrid-1.0.0';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalCdf(z) {
  // Abramowitz-Stegun approximation; absolute error is small enough for display/scoring.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Estimate P(team score > line).
 *
 * Required independent input: teamPointsPerGame and opponentPointsAllowedPerGame.
 * Optional context:
 * - recentPointsPerGame: recent form (shrunk toward season average)
 * - injuryAdjustment: expected points lost/gained due to availability
 * - weatherAdjustment: expected scoring impact
 * - paceAdjustment: expected possessions/pace impact
 * - scoreStdDev: historical standard deviation; defaults to 7 points
 * - gamesSampled: sample size used to derive the averages
 */
export function estimateTeamTotalProbability(context, line) {
  const target = finite(line);
  const teamAvg = finite(context?.teamPointsPerGame);
  const opponentAllowed = finite(context?.opponentPointsAllowedPerGame);
  if (target == null || teamAvg == null || opponentAllowed == null || teamAvg < 0 || opponentAllowed < 0) {
    return { available: false, reason: 'Team scoring average and opponent points allowed are required.' };
  }

  const recent = finite(context.recentPointsPerGame);
  const sample = clamp(finite(context.gamesSampled) ?? 10, 1, 50);
  const recentWeight = recent == null ? 0 : clamp(sample / (sample + 8), 0.15, 0.75);
  const formAdjusted = recent == null ? teamAvg : teamAvg * (1 - recentWeight) + recent * recentWeight;
  const baseline = (formAdjusted * 0.65) + (opponentAllowed * 0.35);
  const adjustments = {
    injury: finite(context.injuryAdjustment) ?? 0,
    weather: finite(context.weatherAdjustment) ?? 0,
    pace: finite(context.paceAdjustment) ?? 0,
  };
  const expectedPoints = baseline + adjustments.injury + adjustments.weather + adjustments.pace;
  const sigma = clamp(finite(context.scoreStdDev) ?? 7, 3, 20);
  const probability = clamp(normalCdf((expectedPoints - target) / sigma), 0.01, 0.99);
  const confidence = clamp(0.35 + (sample / (sample + 12)) * 0.45, 0.35, 0.80);

  return {
    available: true,
    modelVersion: MODEL_VERSION,
    expectedPoints: Number(expectedPoints.toFixed(2)),
    scoreStdDev: sigma,
    modelProbability: Number(probability.toFixed(4)),
    confidence: Number(confidence.toFixed(3)),
    adjustments,
    inputs: {
      teamPointsPerGame: teamAvg,
      opponentPointsAllowedPerGame: opponentAllowed,
      recentPointsPerGame: recent,
      gamesSampled: sample,
    },
    method: 'normal-score-distribution',
  };
}

/** Compare an independent model probability with Kalshi's executable YES ask. */
export function calculateEdge(modelProbability, yesAsk, feePerContract = 0) {
  const probability = finite(modelProbability);
  const price = finite(yesAsk);
  const fee = Math.max(0, finite(feePerContract) ?? 0);
  if (probability == null || price == null || price <= 0 || price >= 1) {
    return { available: false, reason: 'A model probability and valid YES ask are required.' };
  }
  const effectiveCost = price + fee;
  return {
    available: true,
    marketProbability: Number(price.toFixed(4)),
    modelProbability: Number(probability.toFixed(4)),
    edge: Number((probability - effectiveCost).toFixed(4)),
    expectedValuePerContract: Number((probability - effectiveCost).toFixed(4)),
    feePerContract: fee,
  };
}

/** Convert raw research into a constrained, auditable context object. */
export function normalizeResearchContext(input = {}) {
  const fields = [
    'teamPointsPerGame', 'opponentPointsAllowedPerGame', 'recentPointsPerGame',
    'injuryAdjustment', 'weatherAdjustment', 'paceAdjustment', 'scoreStdDev', 'gamesSampled',
  ];
  const context = {};
  for (const key of fields) {
    const value = finite(input[key]);
    if (value != null) context[key] = value;
  }
  if (typeof input.source === 'string') context.source = input.source.slice(0, 300);
  if (typeof input.asOf === 'string' && !Number.isNaN(Date.parse(input.asOf))) context.asOf = input.asOf;
  if (typeof input.notes === 'string') context.notes = input.notes.slice(0, 2000);
  return context;
}
