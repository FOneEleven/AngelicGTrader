// Azure Functions Node.js v4: strict pregame matchup interrogation.
// This endpoint is deliberately independent of the baseline market-analysis model.

const { app } = require('@azure/functions');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_MODEL || 'gpt-6.2-astra';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['KEEP', 'REJECT', 'REVIEW'] },
    probabilityYes: { type: 'number' },
    baseProbabilityYes: { type: 'number' },
    motivationAdjustmentPoints: { type: 'number' },
    motivationAssessment: { type: 'string' },
    opponentPercentile: { type: ['number', 'null'] },
    opponentPercentileRationale: { type: 'string' },
    matchupGrade: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
    closingTimeAssessment: { type: 'string' },
    fantasyUpsideAssessment: { type: 'string' },
    reasoning: { type: 'array', items: { type: 'string' } },
    advantages: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    missingData: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'verdict', 'probabilityYes', 'baseProbabilityYes', 'motivationAdjustmentPoints',
    'motivationAssessment', 'opponentPercentile', 'opponentPercentileRationale',
    'matchupGrade', 'closingTimeAssessment', 'fantasyUpsideAssessment',
    'reasoning', 'advantages', 'risks', 'missingData',
  ],
};

function getOutputText(response) {
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'refusal') throw new Error('OpenAI refused final interrogation');
      if (content.type === 'output_text') return content.text;
    }
  }
  throw new Error('OpenAI returned no final interrogation text');
}

function rejected(reason, market) {
  return {
    verdict: 'REJECT',
    interrogation: {
      verdict: 'REJECT',
      probabilityYes: 0.5,
      baseProbabilityYes: 0.5,
      motivationAdjustmentPoints: 0,
      motivationAssessment: 'Not evaluated: pregame eligibility failed.',
      opponentPercentile: null,
      opponentPercentileRationale: 'Not evaluated.',
      matchupGrade: 'D',
      closingTimeAssessment: reason,
      fantasyUpsideAssessment: 'Not evaluated.',
      reasoning: [reason],
      advantages: [],
      risks: ['Late market repricing and holders selling to preserve residual value are not evidence that an outcome remains safe.'],
      missingData: [],
    },
    audit: { eventStartTime: market?.occurrenceTime || market?.gameTime || null, rejectedBeforeOpenAI: true },
  };
}

async function finalInterrogate(body) {
  const market = body.market || {};
  const candidate = body.candidate || {};
  const teamStats = body.teamStats || {};
  const opponentStats = body.opponentStats || {};
  const eventStart = market.occurrenceTime || market.gameTime || null;
  const eventStartMs = eventStart ? Date.parse(eventStart) : NaN;
  const marketCloseMs = market.closeTime ? Date.parse(market.closeTime) : NaN;
  const status = String(market.marketStatus || market.status || '').toLowerCase();

  // occurrenceTime is the actual contest start. Kalshi closeTime and
  // expectedExpiration describe the contract lifecycle and must never stand in
  // for kickoff. Missing kickoff is an automatic fail-closed rejection.
  if (!Number.isFinite(eventStartMs)) return rejected('Official contest start time is missing. Cannot establish that this is a pregame opportunity.', market);
  if (eventStartMs <= Date.now()) return rejected('Contest has already started. Reject regardless of the current payout, ask, or apparent value.', market);
  if (Number.isFinite(marketCloseMs) && marketCloseMs <= Date.now()) return rejected('Kalshi market has already closed. No new position is eligible.', market);
  if (status && !['open', 'active'].includes(status)) return rejected('Kalshi market status is ' + status + ', not tradable open.', market);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const currentAsk = Number(candidate.ask);
  const currentPayout = Number(candidate.payoutMultiple);
  const input = {
    asOf: new Date().toISOString(),
    contest: {
      league: market.league || candidate.league || '',
      team: market.team || candidate.team || teamStats.name || '',
      opponent: market.opponent || opponentStats.name || '',
      eventStartTime: eventStart,
      hoursUntilStart: (eventStartMs - Date.now()) / 3600000,
      kalshiMarketCloseTime: market.closeTime || null,
      expectedExpiration: market.expectedExpiration || null,
      marketStatus: status || 'not supplied',
    },
    contract: {
      ticker: market.ticker || candidate.ticker || '',
      title: market.title || '',
      line: market.line ?? candidate.line ?? null,
      selectedSide: candidate.side || '',
      selectedAsk: Number.isFinite(currentAsk) ? currentAsk : null,
      currentYesAsk: market.yesAsk ?? null,
      currentNoAsk: market.noAsk ?? null,
      displayedPayoutMultiple: Number.isFinite(currentPayout) ? currentPayout : null,
    },
    candidateBaseline: body.baselinePrediction || {},
    candidate: {
      probability: candidate.probability ?? null,
      edge: candidate.edge ?? null,
      strategy: candidate.strategy || '',
      risk: candidate.risk || '',
    },
    teamStatistics: teamStats,
    opponentStatistics: opponentStats,
    season: body.season || null,
    pieceInstruction: String(body.pieceInstruction || '').slice(0, 2000),
    policy: {
      seriousGameMotivationBonus: '+4 percentage points when there is concrete evidence this team has a meaningful reason to compete hard.',
      lowStakesHighProfilePenalty: '-6 percentage points when a high-profile team has little at stake, is comfortable/secure, and has credible reason to manage effort or minutes.',
      opponentStrengthPercentile: 'Use league-relative opponent strength percentile where 0 is weakest and 100 is strongest. Preferred opponent range is 10–40 inclusive.',
      objective: 'Serious, down-to-business contests with strong fantasy upside.',
    },
  };

  const instructions = `
You are AngelicGTrader's FINAL INTERROGATOR. Your job is to challenge a prequalified team-total candidate and protect the user from false safety signals.

ABSOLUTE PREGAME / CLOSING-TIME RULES:
- The contest eventStartTime is the actual scheduled game start. It has already passed the server-side gate, but independently verify it is still in the future when analyzing. If not, REJECT.
- kalshiMarketCloseTime and expectedExpiration are contract lifecycle timestamps, NOT game start time. Never confuse a market closing countdown with time until tipoff/kickoff/first pitch.
- Current ask and payout multiple are live market conditions. A payout multiple rising as a contest approaches or progresses can be caused by holders dumping positions to salvage residual value after the underlying bet is failing. That is adverse late-selling/liquidation pressure, NOT evidence the bet is safe, NOT a probability boost, and NOT a reason to chase.
- Evaluate whether the market is still open and whether the game is genuinely pregame. If the game has begun, REJECT. Do not issue REVIEW for an already-started contest.

TEAM MOTIVATION ADJUSTMENTS — EXACTLY IN PERCENTAGE POINTS:
- Start with candidateBaseline.probabilityYes as the base probability. Do not anchor to it; independently challenge it.
- Apply +4 percentage points to the selected team's outcome probability only when concrete supplied evidence indicates the team has a meaningful reason to compete hard (playoff/seeding/elimination implications, meaningful standings pressure, a must-win, or similarly credible stakes). Generic professional pride is not sufficient.
- Apply -6 percentage points when BOTH conditions are supported: the team is a high-profile/elite brand AND it has little meaningful need to win / is comfortable in its position, with credible risk of reduced urgency, rotation, or managed minutes. Fame alone is not enough.
- If both conditions genuinely apply, net the adjustments (+4 and -6 = -2 points). If neither is evidenced, adjustment is 0. Do not invent standings, playoff status, injuries, or motivation.
- Return baseProbabilityYes, motivationAdjustmentPoints, and adjusted probabilityYes. probabilityYes = clamp(baseProbabilityYes + adjustmentPoints/100, 0, 1). State clearly what evidence justified the adjustment.

OPPONENT QUALITY FILTER:
- Estimate opponent's league-relative strength percentile on a 0–100 scale (0 = weakest, 100 = strongest), using supplied ranks, record, efficiency, and season/recent statistics.
- Preferred opponent percentile is 10 through 40 inclusive. This is a deliberate matchup filter: favor teams that are motivated and face a weaker but competitive opponent, not a dominant opponent and not an uncompetitive mismatch.
- Do not fabricate a percentile. If evidence is insufficient, set opponentPercentile=null, explain the missing basis, add it to missingData, and set verdict=REVIEW.
- If a reliable percentile is outside 10–40, REJECT the candidate for this strategy.

SERIOUS GAME + FANTASY UPSIDE:
- Assess whether the team is likely to play its normal serious rotation and whether the game has meaningful competitive intensity.
- Evaluate fantasy upside through available pace, scoring environment, usage/volume, recent form, and role/rotation evidence. Do not invent individual player projections when no player data is supplied.
- Prefer meaningful games with strong opportunity/volume. Penalize blowout/low-effort risk, likely rest, rotation uncertainty, and low-stakes games.

PROBABILITY AND VERDICT:
- Do not use Kalshi ask, payout multiple, or market price to create the probability estimate.
- Explain both supporting and opposing evidence. A high raw probability alone is not sufficient.
- KEEP only when the opponent percentile is reliably 10–40, motivation/rotation is credible, fantasy upside is acceptable, matchup grade is A or B, and no material missing information undermines the decision.
- REJECT when opponent percentile is reliably outside 10–40, motivation/rotation risk is material, the matchup is poor, or pregame/market eligibility fails.
- REVIEW only when a key fact (especially opponent percentile, standings motivation, rotation, or schedule status) cannot be verified. Never use REVIEW as a substitute for rejecting an already-started contest.
- Return only the requested structured object.
`.trim();

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: 'angelic_final_interrogation', strict: true, schema } },
      max_output_tokens: 2600,
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('OpenAI HTTP ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
  if (data.status !== 'completed') throw new Error('OpenAI response incomplete: ' + data.status);
  const result = JSON.parse(getOutputText(data));

  // Enforce deterministic strategy boundaries after the model responds.
  let verdict = result.verdict;
  const percentile = result.opponentPercentile;
  if (percentile == null || !Number.isFinite(Number(percentile))) verdict = 'REVIEW';
  else if (Number(percentile) < 10 || Number(percentile) > 40) verdict = 'REJECT';
  if (!['A', 'B'].includes(result.matchupGrade) && verdict === 'KEEP') verdict = 'REJECT';
  if (result.missingData?.length && verdict === 'KEEP') verdict = 'REVIEW';

  return {
    verdict,
    interrogation: { ...result, verdict },
    audit: {
      model: MODEL,
      responseId: data.id,
      eventStartTime: eventStart,
      hoursUntilStart: (eventStartMs - Date.now()) / 3600000,
      marketCloseTime: market.closeTime || null,
      currentAsk,
      currentPayoutMultiple: Number.isFinite(currentPayout) ? currentPayout : null,
      opponentPercentileBand: [10, 40],
      motivationAdjustments: { seriousGameBonusPoints: 4, highProfileLowStakesPenaltyPoints: -6 },
    },
  };
}

app.http('FinalInterrogation', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') return { status: 204, headers: CORS };
    try {
      const body = await request.json();
      if (!body.market || !body.candidate || !body.teamStats || !body.opponentStats) {
        return { status: 400, headers: CORS, jsonBody: { error: 'candidate, market, teamStats, and opponentStats are required' } };
      }
      const result = await finalInterrogate(body);
      return { status: 200, headers: CORS, jsonBody: result };
    } catch (error) {
      context.error('FinalInterrogation failed: ' + error.message);
      return { status: 502, headers: CORS, jsonBody: { error: error.message } };
    }
  },
});
