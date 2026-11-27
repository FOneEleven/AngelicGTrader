// Azure Function (v4 model): OpenAI market analysis for AngelicGTrader.
// MLB uses a separate NO-only team-runs strategy with early weather screening.

const { app } = require('@azure/functions');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const MODEL = process.env.OPENAI_MODEL || 'gpt-6.2-astra';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probabilityYes: { type: 'number', description: 'Estimated probability of YES, from 0 to 1.' },
    expectedTeamPoints: { type: 'number' },
    recommendation: { type: 'string', enum: ['YES', 'NO', 'NO_BET'] },
    confidence: { type: 'number', description: 'Confidence from 0 to 100.' },
    upsetSignal: { type: 'boolean' },
    historicalPerformanceRequired: { type: 'string' },
    reasoning: { type: 'array', items: { type: 'string' } },
    advantages: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    missingData: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'probabilityYes', 'expectedTeamPoints', 'recommendation', 'confidence',
    'upsetSignal', 'historicalPerformanceRequired', 'reasoning', 'advantages',
    'risks', 'missingData',
  ],
};

function normalizePrice(value) {
  if (value == null || value === '') return null;
  let price = Number(value);
  if (!Number.isFinite(price)) return null;
  if (price > 1) price /= 100;
  return price >= 0 && price <= 1 ? price : null;
}

function calculateValue(probability, yesAsk, noAsk, fee) {
  const noProbability = 1 - probability;
  const yesEV = yesAsk == null ? null : probability - yesAsk - fee;
  const noEV = noAsk == null ? null : noProbability - noAsk - fee;
  let bestSide = 'NO_BET', bestEV = 0;
  if (yesEV != null && yesEV > bestEV) { bestSide = 'YES'; bestEV = yesEV; }
  if (noEV != null && noEV > bestEV) { bestSide = 'NO'; bestEV = noEV; }
  return {
    marketProbabilityYes: null,
    marketProbabilityNo: null,
    yesExpectedValuePerContract: yesEV,
    noExpectedValuePerContract: noEV,
    bestValueSide: bestSide,
    bestExpectedValuePerContract: bestEV,
  };
}

function getOutputText(response) {
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'refusal') throw new Error('OpenAI refused the analysis request');
      if (content.type === 'output_text') return content.text;
    }
  }
  throw new Error('OpenAI returned no analysis text');
}

async function callOpenAI(input, isMLB) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const instructions = `
You are the analytical prediction engine for AngelicGTrader.

Analyze sports prediction markets using the supplied statistics,
historical game results, market lines, and prices.

GENERAL RULES:
1. Estimate probability independently of the Kalshi market price.
2. Never use market price as your estimated probability.
3. Do not invent statistics, injuries, weather, or historical results.
4. Identify missing or incomplete information.
5. Consider sample size and the reliability of recent form.
6. Distinguish historical evidence from speculation.
7. If evidence is insufficient, recommend NO_BET.
8. Evaluate the actual threshold, including half-point lines.
9. A high probability does not necessarily mean a good price.
10. Be careful about correlated bets and repeated exposure.
11. Return the requested structured output only.

${isMLB ? `
MLB STRATEGY — STRICT NO-ONLY TEAM RUN TOTALS:
- This is not a moneyline or game-total analysis. Evaluate only the named team's runs against this exact team-run threshold.
- AngelicGTrader takes NO only. Never recommend YES. If NO does not meet every requirement, return NO_BET.
- The user wants to evaluate markets roughly 24–96 hours before scheduled first pitch, while the NO price may still offer value. Do not wait until game day to discover a weather edge.
- Use the supplied MLB season and recent hitting statistics, opponent pitching/run prevention, probable starting pitcher when available, venue, game time, and weather forecast.
- Weather is an early screening input. Cold temperatures can suppress offense. Consider humidity as a contextual variable, but do not assume high humidity alone suppresses scoring; humid air can be less dense. Wind speed/direction must not be called an inward headwind unless stadium orientation is known.
- A likely rainout is an automatic NO_BET. Do not treat rainout risk as a reason to buy NO; the user wants games expected to be played.
- Missing weather, missing venue, missing team run-rate, missing opponent run-prevention data, or a game outside the 24–96 hour entry window means NO_BET.
- Account for ordinary run-to-run variance, bullpen usage, starting pitcher uncertainty, lineup uncertainty, and the chance of an unusually high-scoring game. Do not claim certainty.
- Recommend NO only when estimated probability of the YES run threshold is at most 10%, confidence is at least 85/100, and the NO expected value after fees is at least 5 cents per contract. Otherwise NO_BET.
- Do not increase probability merely because weather looks unfavorable. Weather is one factor in a statistical run distribution, not a guarantee.
` : `
Find mispriced outcomes, including underdogs with stronger historical performance than market expectations, team totals requiring unusually strong scoring performances, NO positions where YES requires historically uncommon performance, and recent form that differs from season averages.
- Do not automatically favor YES or NO.
`}
`.trim();

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          instructions,
          input: JSON.stringify(input),
          text: { format: { type: 'json_schema', name: 'angelic_market_analysis', strict: true, schema } },
          max_output_tokens: 1800,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error('OpenAI HTTP ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
      if (data.status !== 'completed') throw new Error('OpenAI response incomplete: ' + data.status);
      return { analysis: JSON.parse(getOutputText(data)), responseId: data.id };
    } catch (error) {
      lastError = error;
      if (attempt < 2 && /HTTP (429|500|502|503|504)|fetch failed|timed out/i.test(error.message)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function analyzeMarketHandler(context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: CORS, body: '' };
    return;
  }

  try {
    const started = Date.now();
    const body = req.body || {};
    const market = body.market;
    const teamStats = body.teamStats;
    const opponentStats = body.opponentStats || null;
    if (!market || !teamStats) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'market and teamStats are required' }) };
      return;
    }

    const isMLB = String(market.league || '').toUpperCase() === 'MLB'
      || /^KXMLBTEAMTOTAL-/.test(String(market.ticker || ''));
    const yesAsk = normalizePrice(market.yesAsk ?? market.yes_ask);
    const noAsk = normalizePrice(market.noAsk ?? market.no_ask);
    const fee = normalizePrice(market.feePerContract ?? 0) ?? 0;
    const line = Number(market.line ?? market.floorStrike);
    if (!Number.isFinite(line)) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'A valid market line is required' }) };
      return;
    }

    const mlbContext = body.context?.mlb || {};
    const weather = mlbContext.weather || null;
    const gameTime = market.gameTime || market.occurrenceTime || market.closeTime || null;
    const hoursToGame = gameTime ? (new Date(gameTime).getTime() - Date.now()) / 3600000 : null;
    const weatherComplete = !!weather
      && Number.isFinite(Number(weather.temperatureF))
      && Number.isFinite(Number(weather.humidityPercent))
      && Number.isFinite(Number(weather.precipitationProbability))
      && Number.isFinite(Number(weather.windMph));
    const withinEarlyWindow = hoursToGame != null && hoursToGame >= 24 && hoursToGame <= 96;
    const rainoutRisk = weather?.rainoutRisk === true;
    const mlbRejectReason = !withinEarlyWindow ? 'Outside the 24–96 hour early-entry window.'
      : rainoutRisk ? 'Forecast indicates elevated rainout risk.'
      : !weatherComplete ? 'Required game-time weather forecast is incomplete.'
      : !teamStats.pointsPerGame || !opponentStats?.pointsAllowedPerGame ? 'Required team runs or opponent runs-allowed statistics are missing.'
      : null;

    const input = {
      market: {
        ticker: market.ticker || '',
        title: market.title || '',
        league: market.league || '',
        team: market.team || teamStats.name || '',
        opponent: market.opponent || opponentStats?.name || '',
        line,
        yesAsk,
        noAsk,
        closesAt: market.closeTime || market.closesAt || null,
        gameTime,
        hoursToGame,
      },
      teamStatistics: teamStats,
      opponentStatistics: opponentStats,
      additionalContext: body.context || {},
      analysisInstructions: {
        objective: isMLB ? 'Estimate probability of the team scoring OVER the exact run threshold; NO-only decision.' : 'Independent probability estimation',
        focus: isMLB
          ? ['team runs distribution', 'season and recent hitting', 'opponent pitching and run prevention', 'probable starting pitcher', 'venue and game-time weather', 'rainout exclusion', 'conservative NO value']
          : ['upset opportunities', 'team scoring thresholds', 'historical performance required', 'undervalued NO contracts', 'recent versus season performance'],
      },
    };

    if (isMLB && mlbRejectReason) {
      const rejected = {
        probabilityYes: 0.5, expectedTeamPoints: Number(teamStats.pointsPerGame) || 0,
        recommendation: 'NO_BET', confidence: 0, upsetSignal: false,
        historicalPerformanceRequired: 'Not evaluated: ' + mlbRejectReason,
        reasoning: [mlbRejectReason],
        advantages: [], risks: [mlbRejectReason], missingData: [],
      };
      context.res = {
        status: 200, headers: CORS,
        body: JSON.stringify({
          provider: 'OpenAI', model: MODEL, analyzedAt: new Date().toISOString(),
          durationMs: Date.now() - started, market: { ticker: market.ticker || '', title: market.title || '', line, yesAsk, noAsk },
          prediction: rejected,
          marketValue: { bestValueSide: 'NO_BET', bestExpectedValuePerContract: 0, yesExpectedValuePerContract: null, noExpectedValuePerContract: null, feePerContract: fee },
          mlbEligibility: { eligible: false, reason: mlbRejectReason, hoursToGame, rainoutRisk },
          audit: { probabilityIsIndependentOfMarketPrice: true, statisticsProvidedBy: 'MLB Stats API', weatherProvidedBy: weather?.source || null, input },
        }),
      };
      return;
    }

    context.log('AnalyzeMarket: ' + (market.ticker || market.title || 'Unknown market'));
    const result = await callOpenAI(input, isMLB);
    const analysis = result.analysis;
    if (!Number.isFinite(analysis.probabilityYes) || analysis.probabilityYes < 0 || analysis.probabilityYes > 1) {
      throw new Error('Invalid probability returned by OpenAI');
    }

    const value = calculateValue(analysis.probabilityYes, yesAsk, noAsk, fee);
    let recommendation = analysis.confidence < 35 ? 'NO_BET' : analysis.recommendation;
    let mlbEligibility = null;

    if (isMLB) {
      const noProbability = 1 - analysis.probabilityYes;
      const noEV = value.noExpectedValuePerContract;
      const eligible = noProbability >= 0.90
        && analysis.confidence >= 85
        && noAsk != null
        && noEV != null && noEV >= 0.05;
      recommendation = eligible ? 'NO' : 'NO_BET';
      value.bestValueSide = eligible ? 'NO' : 'NO_BET';
      value.bestExpectedValuePerContract = eligible ? noEV : 0;
      mlbEligibility = {
        eligible,
        reason: eligible ? 'Passed MLB NO-only probability, confidence, and price-value gates.'
          : 'Did not meet every MLB NO-only threshold: NO probability ≥90%, confidence ≥85, and net NO value ≥5¢.',
        hoursToGame,
        rainoutRisk,
        noProbability,
        minimumNoProbability: 0.90,
        minimumConfidence: 85,
        minimumNetNoValue: 0.05,
      };
    }

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        provider: 'OpenAI',
        model: MODEL,
        responseId: result.responseId,
        analyzedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        market: { ticker: market.ticker || '', title: market.title || '', line, yesAsk, noAsk },
        prediction: { ...analysis, recommendation },
        marketValue: {
          ...value,
          marketProbabilityYes: yesAsk,
          marketProbabilityNo: noAsk,
          feePerContract: fee,
        },
        ...(isMLB ? { mlbEligibility } : {}),
        audit: {
          model: MODEL,
          probabilityIsIndependentOfMarketPrice: true,
          statisticsProvidedBy: isMLB ? 'MLB Stats API' : 'ESPN',
          weatherProvidedBy: isMLB ? (weather?.source || null) : null,
          input,
        },
      }),
    };
  } catch (error) {
    context.log.error('AnalyzeMarket failed:', error.message);
    context.res = {
      status: 502,
      headers: CORS,
      body: JSON.stringify({
        error: error.message,
        provider: 'OpenAI',
        retryable: /429|500|502|503|504|timed out/i.test(error.message),
      }),
    };
  }
}

app.http('AnalyzeMarket', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    let body = {};
    if (request.method !== 'OPTIONS') {
      try { body = await request.json(); } catch { body = {}; }
    }
    const legacyLog = (...args) => context.log(...args);
    legacyLog.error = (...args) => context.error(...args);
    const legacyContext = { log: legacyLog, res: null };
    await analyzeMarketHandler(legacyContext, { method: request.method, body });
    const result = legacyContext.res || { status: 204, headers: CORS, body: '' };
    return { status: result.status, headers: result.headers, body: result.body };
  },
});
