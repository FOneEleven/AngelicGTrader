const { app } = require('@azure/functions');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_MODEL || 'gpt-6.2-astra';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const MLB_SCHEDULE_URL = 'https://statsapi.mlb.com/api/v1/schedule';

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
    'verdict', 'probabilityYes', 'baseProbabilityYes',
    'motivationAdjustmentPoints', 'motivationAssessment',
    'opponentPercentile', 'opponentPercentileRationale',
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

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(dateString, days) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return utcDate(date);
}

function scoreboardDateRanges(eventStart) {
  const today = utcDate(new Date());
  const ranges = [{ start: shiftDate(today, -3), end: shiftDate(today, 10) }];
  const hintMs = eventStart ? Date.parse(eventStart) : NaN;
  if (Number.isFinite(hintMs)) {
    const hintDate = utcDate(new Date(hintMs));
    const daysFromNow = Math.abs(hintMs - Date.now()) / 86400000;
    // A stale timestamp from a previous scan must not expand the search back
    // indefinitely. A nearby hint can add a second broad schedule window.
    if (daysFromNow <= 14 && !ranges.some((r) => hintDate >= r.start && hintDate <= r.end)) {
      ranges.push({ start: shiftDate(hintDate, -3), end: shiftDate(hintDate, 3) });
    }
  }
  return ranges;
}

async function fetchJson(url, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Scoreboard HTTP ' + response.status);
  return response.json();
}

function espnLeaguePath(league) {
  if (league === 'NBA') return 'basketball/nba';
  if (league === 'NFL') return 'football/nfl';
  return null;
}

function espnCompetitorNames(competitor) {
  const team = competitor?.team || {};
  return [
    team.displayName, team.shortDisplayName, team.name,
    team.abbreviation, team.location, team.nickname,
    competitor?.displayName,
  ].filter(Boolean);
}

function classifyEspnStatus(event) {
  const type = event?.status?.type || {};
  const state = String(type.state || '').toLowerCase();
  const name = String(type.name || '').toLowerCase();
  const description = String(type.description || '').toLowerCase();

  if (type.completed === true || state === 'post' || name.includes('final') || description.includes('final')) return 'FINAL';
  if (state === 'in' || name.includes('progress') || name.includes('halftime') || name.includes('live')) return 'LIVE';
  if (state === 'pre' || name.includes('scheduled') || name.includes('pre')) return 'PRE';
  return 'UNKNOWN';
}

function normalizeEspnEvent(event, league) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1];
  const status = event.status || competition?.status || {};
  return {
    source: 'ESPN',
    league,
    eventId: event.id || null,
    eventName: event.name || event.shortName || '',
    eventStartTime: event.date || null,
    status: classifyEspnStatus({ ...event, status }),
    statusName: status.type?.name || status.type?.description || '',
    statusDetail: status.type?.detail || status.type?.shortDetail || '',
    period: status.period ?? null,
    clock: status.displayClock || null,
    homeTeam: espnCompetitorNames(home),
    awayTeam: espnCompetitorNames(away),
    homeScore: home?.score ?? null,
    awayScore: away?.score ?? null,
    rawStatus: status.type || {},
  };
}

async function fetchEspnScoreboard(league, ranges) {
  const path = espnLeaguePath(league);
  if (!path) throw new Error('Unsupported ESPN league: ' + league);
  const results = await Promise.allSettled(ranges.map(async ({ start, end }) => {
    const url = new URL(ESPN_BASE + '/' + path + '/scoreboard');
    url.searchParams.set('dates', start.replace(/-/g, '') + '-' + end.replace(/-/g, ''));
    url.searchParams.set('limit', '1000');
    const data = await fetchJson(url.toString());
    return (data.events || []).map((event) => normalizeEspnEvent(event, league));
  }));
  const events = [];
  const failures = [];
  for (const result of results) {
    if (result.status === 'fulfilled') events.push(...result.value);
    else failures.push(result.reason?.message || 'ESPN request failed');
  }
  const unique = new Map(events.filter((event) => event.eventId).map((event) => [event.eventId, event]));
  if (!unique.size && failures.length === results.length) throw new Error('ESPN scoreboard unavailable: ' + failures.join('; '));
  return [...unique.values()];
}

function classifyMlbStatus(game) {
  const abstract = String(game.status?.abstractGameState || '').toLowerCase();
  const detailed = String(game.status?.detailedState || '').toLowerCase();
  if (abstract === 'final' || detailed.includes('final') || detailed.includes('completed')) return 'FINAL';
  if (abstract === 'live' || detailed.includes('in progress') || detailed.includes('warmup')) return 'LIVE';
  if (detailed.includes('delayed') || abstract === 'preview' || detailed.includes('scheduled') || detailed.includes('pre-game')) return 'PRE';
  return 'UNKNOWN';
}

function normalizeMlbGame(game) {
  const home = game.teams?.home || {};
  const away = game.teams?.away || {};
  const linescore = game.linescore || {};
  return {
    source: 'MLB Stats API',
    league: 'MLB',
    eventId: String(game.gamePk || ''),
    eventName: (away.team?.name || '') + ' at ' + (home.team?.name || ''),
    eventStartTime: game.gameDate || null,
    status: classifyMlbStatus(game),
    statusName: game.status?.detailedState || '',
    statusDetail: game.status?.reason || '',
    period: linescore.currentInning ?? null,
    inningState: linescore.inningState || null,
    clock: null,
    homeTeam: [home.team?.name, home.team?.clubName, home.team?.teamName, home.team?.abbreviation].filter(Boolean),
    awayTeam: [away.team?.name, away.team?.clubName, away.team?.teamName, away.team?.abbreviation].filter(Boolean),
    homeScore: home.score ?? null,
    awayScore: away.score ?? null,
    outs: linescore.outs ?? null,
    balls: linescore.balls ?? null,
    strikes: linescore.strikes ?? null,
    rawStatus: game.status || {},
  };
}

async function fetchMlbScoreboard(ranges) {
  const results = await Promise.allSettled(ranges.map(async ({ start, end }) => {
    const url = new URL(MLB_SCHEDULE_URL);
    url.searchParams.set('sportId', '1');
    url.searchParams.set('startDate', start);
    url.searchParams.set('endDate', end);
    url.searchParams.set('hydrate', 'linescore');
    const data = await fetchJson(url.toString());
    return (data.dates || []).flatMap((entry) => (entry.games || []).map(normalizeMlbGame));
  }));
  const events = [];
  const failures = [];
  for (const result of results) {
    if (result.status === 'fulfilled') events.push(...result.value);
    else failures.push(result.reason?.message || 'MLB request failed');
  }
  const unique = new Map(events.filter((event) => event.eventId).map((event) => [event.eventId, event]));
  if (!unique.size && failures.length === results.length) throw new Error('MLB scoreboard unavailable: ' + failures.join('; '));
  return [...unique.values()];
}

function eventMatchesTeams(event, team, opponent) {
  const homeMatches = event.homeTeam.some((name) => namesMatch(name, team));
  const awayMatches = event.awayTeam.some((name) => namesMatch(name, team));
  if (!homeMatches && !awayMatches) return false;
  if (!opponent) return false;
  return homeMatches
    ? event.awayTeam.some((name) => namesMatch(name, opponent))
    : event.homeTeam.some((name) => namesMatch(name, opponent));
}

async function verifyLiveScoreboard({ league, team, opponent, eventStart }) {
  const normalizedLeague = String(league || '').toUpperCase();
  if (!['NBA', 'NFL', 'MLB'].includes(normalizedLeague)) {
    return { verified: false, status: 'UNKNOWN', reason: 'No supported live scoreboard is configured for league ' + normalizedLeague };
  }
  if (!team || !opponent) {
    return { verified: false, status: 'UNKNOWN', reason: 'Both team and opponent are required to identify the exact event.' };
  }

  const ranges = scoreboardDateRanges(eventStart);
  let events;
  try {
    events = normalizedLeague === 'MLB'
      ? await fetchMlbScoreboard(ranges)
      : await fetchEspnScoreboard(normalizedLeague, ranges);
  } catch (error) {
    return { verified: false, status: 'UNKNOWN', reason: error.message || 'Live scoreboard could not be reached.', checkedRanges: ranges };
  }

  const matches = events.filter((event) => eventMatchesTeams(event, team, opponent));
  if (!matches.length) {
    return {
      verified: false, status: 'UNKNOWN',
      reason: 'No exact team-versus-opponent event was found in the scoreboard search window.',
      checkedRanges: ranges, scoreboardEventsFound: events.length,
    };
  }

  if (matches.length > 1) {
    return {
      verified: false, status: 'UNKNOWN',
      reason: 'More than one event matched the exact team and opponent in the search window. Refusing to choose the wrong game.',
      checkedRanges: ranges,
      matches: matches.map((event) => ({
        eventId: event.eventId, eventName: event.eventName,
        eventStartTime: event.eventStartTime, status: event.status,
        homeTeam: event.homeTeam, awayTeam: event.awayTeam,
      })),
    };
  }

  return {
    verified: true,
    status: matches[0].status,
    event: matches[0],
    checkedRanges: ranges,
    checkedAt: new Date().toISOString(),
  };
}

function eligibilityResult(verdict, reason, market, scoreboard) {
  const event = scoreboard?.event || {};
  return {
    verdict,
    interrogation: {
      verdict,
      probabilityYes: 0.5,
      baseProbabilityYes: 0.5,
      motivationAdjustmentPoints: 0,
      motivationAssessment: '0 pp — not evaluated because event eligibility was not established.',
      opponentPercentile: null,
      opponentPercentileRationale: 'Not evaluated.',
      matchupGrade: 'D',
      closingTimeAssessment: reason,
      fantasyUpsideAssessment: 'Not evaluated.',
      reasoning: [reason],
      advantages: [],
      risks: [
        'A Kalshi market being active does not establish that the underlying game is pregame.',
        'A rising payout multiple may reflect holders selling out of a losing position after the event has started or been decided.',
      ],
      missingData: verdict === 'REVIEW' ? [reason] : [],
    },
    scoreboard: scoreboard || null,
    audit: {
      eventStartTime: event.eventStartTime || market?.occurrenceTime || market?.gameTime || null,
      scoreboardStatus: scoreboard?.status || 'UNKNOWN',
      scoreboardVerified: scoreboard?.verified === true,
      checkedRanges: scoreboard?.checkedRanges || [],
      rejectedBeforeOpenAI: verdict === 'REJECT',
    },
  };
}

function marketIsClosed(market) {
  if (market.isClosed === true) return true;
  const closeTime = market.closeTime ? Date.parse(market.closeTime) : NaN;
  if (Number.isFinite(closeTime) && closeTime <= Date.now()) return true;
  const status = String(market.marketStatus || market.status || '').toLowerCase();
  // Unknown/missing status is not proof of closure. Only explicit terminal states reject.
  return ['closed', 'settled', 'final', 'inactive', 'suspended', 'cancelled', 'canceled'].includes(status);
}

async function finalInterrogate(body) {
  const market = body.market || {};
  const candidate = body.candidate || {};
  const teamStats = body.teamStats || {};
  const opponentStats = body.opponentStats || {};
  const league = String(market.league || candidate.league || teamStats.league || '').toUpperCase();
  const team = market.team || candidate.team || teamStats.name || '';
  const opponent = market.opponent || candidate.opponent || opponentStats.name || '';
  const eventStartHint = market.occurrenceTime || market.gameTime || null;

  // Do not use Kalshi occurrenceTime to decide whether the game has started.
  // It is only a secondary schedule-search hint. The scoreboard is authoritative.
  // Verify the underlying event before evaluating contract tradability so every
  // candidate has an auditable game identity and scoreboard status.
  const scoreboard = await verifyLiveScoreboard({ league, team, opponent, eventStart: eventStartHint });
  if (!scoreboard.verified) {
    return eligibilityResult(
      'REVIEW',
      'Could not independently verify the exact event against the live scoreboard: ' + scoreboard.reason,
      market,
      scoreboard,
    );
  }

  const liveEvent = scoreboard.event;
  if (scoreboard.status === 'FINAL') {
    return eligibilityResult(
      'REJECT',
      'Live scoreboard confirms this exact game is FINAL. The market payout or ask cannot make a decided game eligible.',
      market,
      scoreboard,
    );
  }
  if (scoreboard.status === 'LIVE') {
    return eligibilityResult(
      'REJECT',
      'Live scoreboard confirms this exact game is already in progress. No pregame position is eligible.',
      market,
      scoreboard,
    );
  }
  if (scoreboard.status !== 'PRE') {
    return eligibilityResult(
      'REVIEW',
      'The exact event was found, but the scoreboard did not provide a definitive PRE status. Status: ' + scoreboard.status,
      market,
      scoreboard,
    );
  }

  if (marketIsClosed(market)) {
    return eligibilityResult('REJECT', 'The exact event was verified as PRE, but the Kalshi contract is explicitly closed or no longer tradable.', market, scoreboard);
  }

  const scoreboardStartMs = liveEvent.eventStartTime ? Date.parse(liveEvent.eventStartTime) : NaN;
  if (!Number.isFinite(scoreboardStartMs)) {
    return eligibilityResult(
      'REVIEW',
      'The scoreboard identifies the exact event as PRE but has no valid scheduled start time.',
      market,
      scoreboard,
    );
  }
  const delayed = scoreboardStartMs <= Date.now();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const currentAsk = Number(candidate.ask);
  const currentPayout = Number(candidate.payoutMultiple);
  const input = {
    asOf: new Date().toISOString(),
    contest: {
      league, team, opponent,
      scoreboardSource: liveEvent.source,
      scoreboardVerified: true,
      scoreboardStatus: liveEvent.status,
      scoreboardStatusName: liveEvent.statusName,
      scoreboardStatusDetail: liveEvent.statusDetail,
      scoreboardEventId: liveEvent.eventId,
      scoreboardEventName: liveEvent.eventName,
      authoritativeEventStartTime: liveEvent.eventStartTime,
      hoursUntilScheduledStart: (scoreboardStartMs - Date.now()) / 3600000,
      delayedPregame: delayed,
      period: liveEvent.period,
      clock: liveEvent.clock,
      inningState: liveEvent.inningState || null,
      homeTeam: liveEvent.homeTeam,
      awayTeam: liveEvent.awayTeam,
      homeScore: liveEvent.homeScore,
      awayScore: liveEvent.awayScore,
      outs: liveEvent.outs ?? null,
      balls: liveEvent.balls ?? null,
      strikes: liveEvent.strikes ?? null,
      kalshiOccurrenceTimeHint: eventStartHint,
      kalshiMarketCloseTime: market.closeTime || null,
      expectedExpiration: market.expectedExpiration || null,
      marketStatus: market.marketStatus || market.status || 'not supplied',
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
      opponentStrengthMotivation: 'Opponent percentile affects motivation only, never the verdict. Percentile 10–40 inclusive adds +3 percentage points. Percentile above 40 subtracts 3 percentage points only when there is no meaningful playoff, seeding, elimination, or standings incentive. If a high-percentile opponent has meaningful playoff incentive, apply 0 points. Below 10 or unknown percentile applies 0 points.',
      objective: 'Serious, competitive contests with strong fantasy upside.',
    },
  };

  const instructions = \`
You are AngelicGTrader's FINAL INTERROGATOR.

SCOREBOARD VERIFICATION IS MANDATORY:
- The exact event was matched using both teams and the opponent on the live league scoreboard.
- The scoreboard's event ID, scheduled start, and status are authoritative.
- Kalshi occurrenceTime is only a search hint. Never use it to override the scoreboard.
- FINAL and LIVE events are rejected before this model is called.
- If the scoreboard says PRE but its scheduled start is in the past, treat it as delayed pregame and explicitly say so.
- Never assume a game is pregame because a Kalshi market is active.

MARKET LIQUIDATION:
- A high payout multiple can occur because the underlying bet is already losing or decided and holders are selling to salvage residual value.
- That is liquidation pressure, not evidence of safety, value, or probability.
- Never boost probability because of ask, payout multiple, market price, or a sudden payout increase.

MOTIVATION ADJUSTMENTS — PRESERVE THESE EXISTING RULES:
- Start with candidateBaseline.probabilityYes as the base probability and independently challenge it.
- Opponent percentile affects motivation only; it MUST NOT determine KEEP, REJECT, or REVIEW.
- If opponentPercentile is 10–40 inclusive, apply +3 percentage points to motivation.
- If opponentPercentile is above 40 AND there is no meaningful playoff, seeding, elimination, or standings incentive for the selected team, apply -3 percentage points.
- If opponentPercentile is above 40 but the selected team has a meaningful playoff/seeding/elimination/standings incentive, apply 0 points.
- If opponentPercentile is below 10 or unknown, apply 0 points from percentile.
- Do not invent standings, playoff status, injuries, or motivation.
- motivationAssessment MUST explicitly record the conclusion, evidence, and exact adjustment, including "0 pp" and why when no adjustment applies. Do not leave it blank or merely say "motivation considered".
- Return baseProbabilityYes, motivationAdjustmentPoints, and adjusted probabilityYes.
- probabilityYes must equal clamp(baseProbabilityYes + adjustmentPoints / 100, 0, 1).

OPPONENT QUALITY AND MOTIVATION:
- Estimate opponent league-relative strength percentile from supplied standings, record, efficiency, and season/recent statistics. 0 = weakest, 100 = strongest.
- Do not fabricate a percentile. If evidence is insufficient, use null and explain that the percentile could not be established. This alone is not a missing critical fact and MUST NOT cause REVIEW or REJECT.
- Percentile 10–40 inclusive contributes +3 motivation points.
- Percentile above 40 contributes -3 motivation points only when there is no meaningful playoff, seeding, elimination, or standings incentive. If meaningful incentive exists, contribute 0.
- Percentile below 10 or unknown contributes 0 motivation points.
- The percentile is a motivation input only. It is never a matchup eligibility gate and never independently changes the verdict.

MATCHUP AND VERDICT:
- Assess normal rotation, competitive intensity, pace, scoring environment, usage/volume, recent form, and fantasy upside from supplied evidence.
- Do not invent player projections, injuries, standings, or rotation news.
- KEEP when the matchup is acceptable, motivation/rotation is credible, fantasy upside is acceptable, grade is A or B, and no material missing fact undermines the decision. Opponent percentile is not a KEEP requirement.
- REJECT for material rotation/motivation risk or a poor matchup, not for opponent percentile alone.
- REVIEW when genuinely critical facts about the event or matchup cannot be verified.
- The scoreboard is the source of truth for event status. Market close and expiration are contract timestamps, not game-start evidence.
- Return only the requested structured object.
\`.trim();

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: 'angelic_final_interrogation', strict: true, schema } },
      max_output_tokens: 4000,
    }),
    signal: AbortSignal.timeout(90000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error('OpenAI HTTP ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
  if (data.status !== 'completed') {
    throw new Error('OpenAI response incomplete: ' + data.status + '; reason=' + (data.incomplete_details?.reason || 'unknown'));
  }

  const result = JSON.parse(getOutputText(data));
  const baseProbabilityYes = Number(result.baseProbabilityYes);
  if (!Number.isFinite(baseProbabilityYes) || baseProbabilityYes < 0 || baseProbabilityYes > 1) {
    throw new Error('Final interrogation returned an invalid base probability.');
  }

  const proposedAdjustment = Number(result.motivationAdjustmentPoints);
  const allowedAdjustments = [3, -3, 0];
  const motivationAdjustmentPoints = allowedAdjustments.includes(proposedAdjustment) ? proposedAdjustment : 0;
  result.baseProbabilityYes = baseProbabilityYes;
  result.motivationAdjustmentPoints = motivationAdjustmentPoints;
  result.probabilityYes = Math.max(0, Math.min(1, baseProbabilityYes + motivationAdjustmentPoints / 100));
  result.motivationAssessment = String(result.motivationAssessment || '').trim() ||
    '0 pp — no concrete motivation evidence was returned; no adjustment applied.';
  if (!result.motivationAssessment.includes('pp')) {
    result.motivationAssessment = motivationAdjustmentPoints + ' pp — ' + result.motivationAssessment;
  }

  // Opponent percentile is a motivation input only. It must never override
  // the model's matchup verdict or turn a candidate into REVIEW/REJECT.
  if (!['A', 'B'].includes(result.matchupGrade) && verdict === 'KEEP') verdict = 'REJECT';
  if (result.missingData?.length && verdict === 'KEEP') verdict = 'REVIEW';

  return {
    verdict,
    interrogation: { ...result, verdict },
    scoreboard: {
      verified: true,
      source: liveEvent.source,
      status: liveEvent.status,
      eventId: liveEvent.eventId,
      eventName: liveEvent.eventName,
      eventStartTime: liveEvent.eventStartTime,
      delayedPregame: delayed,
      statusName: liveEvent.statusName,
      statusDetail: liveEvent.statusDetail,
      period: liveEvent.period,
      clock: liveEvent.clock,
      inningState: liveEvent.inningState || null,
      homeTeam: liveEvent.homeTeam,
      awayTeam: liveEvent.awayTeam,
      homeScore: liveEvent.homeScore,
      awayScore: liveEvent.awayScore,
      checkedRanges: scoreboard.checkedRanges,
      checkedAt: scoreboard.checkedAt,
    },
    audit: {
      model: MODEL,
      responseId: data.id,
      scoreboardSource: liveEvent.source,
      scoreboardStatus: liveEvent.status,
      scoreboardEventId: liveEvent.eventId,
      scoreboardEventName: liveEvent.eventName,
      scoreboardStartTime: liveEvent.eventStartTime,
      scoreboardCheckedRanges: scoreboard.checkedRanges,
      delayedPregame: delayed,
      kalshiOccurrenceTimeHint: eventStartHint,
      marketCloseTime: market.closeTime || null,
      currentAsk,
      currentPayoutMultiple: Number.isFinite(currentPayout) ? currentPayout : null,
      opponentPercentileMotivationBand: [10, 40],
      motivationAdjustmentPoints,
      motivationAssessment: result.motivationAssessment,
      baseProbabilityYes,
      finalProbabilityYes: result.probabilityYes,
      motivationAdjustments: { inRangeBonusPoints: 3, highPercentileNoPlayoffIncentivePenaltyPoints: -3 },
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
