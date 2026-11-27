// Azure Functions Node.js v4
// Function name / route: GetTeamStatistics
// Configure SPORTS_STATS_API_URL and optional SPORTS_STATS_API_KEY in Azure
// Function App > Settings > Environment variables. Never expose the key to the browser.
const { app } = require('@azure/functions');

const ALLOWED_LEAGUES = new Set(['NFL', 'NBA']);

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(name + ' is required');
  return text;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

app.http('GetTeamStatistics', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'GetTeamStatistics',
  handler: async (request, context) => {
    try {
      const league = required(request.query.get('league'), 'league').toUpperCase();
      const team = required(request.query.get('team'), 'team');
      const opponent = request.query.get('opponent') || '';
      const season = request.query.get('season') || '';
      const window = request.query.get('window') || 'season';

      if (!ALLOWED_LEAGUES.has(league)) {
        return { status: 400, jsonBody: { error: 'league must be NFL or NBA' } };
      }

      const providerUrl = process.env.SPORTS_STATS_API_URL;
      if (!providerUrl) {
        return {
          status: 503,
          jsonBody: {
            error: 'Sports statistics provider is not configured.',
            requiredSetting: 'SPORTS_STATS_API_URL',
          },
        };
      }

      const url = new URL(providerUrl);
      url.searchParams.set('league', league);
      url.searchParams.set('team', team);
      if (opponent) url.searchParams.set('opponent', opponent);
      if (season) url.searchParams.set('season', season);
      url.searchParams.set('window', window);

      const headers = { Accept: 'application/json' };
      if (process.env.SPORTS_STATS_API_KEY) {
        headers.Authorization = 'Bearer ' + process.env.SPORTS_STATS_API_KEY;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        context.error('Sports provider returned ' + response.status + ': ' + detail);
        return { status: 502, jsonBody: { error: 'Sports statistics provider request failed', providerStatus: response.status } };
      }

      const raw = await response.json();
      const stats = raw.stats || raw;
      const result = {
        league,
        team,
        opponent: opponent || stats.opponent || null,
        season: season || stats.season || null,
        window,
        teamPointsPerGame: finiteOrNull(stats.teamPointsPerGame ?? stats.pointsPerGame),
        opponentPointsAllowedPerGame: finiteOrNull(stats.opponentPointsAllowedPerGame ?? stats.pointsAllowedPerGame),
        recentPointsPerGame: finiteOrNull(stats.recentPointsPerGame),
        recentOpponentPointsAllowedPerGame: finiteOrNull(stats.recentOpponentPointsAllowedPerGame),
        gamesSampled: finiteOrNull(stats.gamesSampled ?? stats.gamesPlayed),
        homePointsPerGame: finiteOrNull(stats.homePointsPerGame),
        awayPointsPerGame: finiteOrNull(stats.awayPointsPerGame),
        offensiveRank: finiteOrNull(stats.offensiveRank),
        defensiveRank: finiteOrNull(stats.defensiveRank),
        source: stats.source || 'configured-sports-provider',
        asOf: stats.asOf || new Date().toISOString(),
        rawProviderFields: stats.rawProviderFields || null,
      };

      if (result.teamPointsPerGame === null || result.opponentPointsAllowedPerGame === null) {
        return {
          status: 422,
          jsonBody: {
            error: 'Provider response is missing required team PPG or opponent points-allowed average.',
            received: result,
          },
        };
      }

      return { status: 200, jsonBody: result };
    } catch (error) {
      const badRequest = / is required$|league must be/.test(error.message);
      return { status: badRequest ? 400 : 500, jsonBody: { error: error.message } };
    }
  },
});
