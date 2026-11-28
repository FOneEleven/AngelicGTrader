// Final candidate interrogation for AngelicGTrader.
// Runs only after the existing scanner has qualified a candidate. It does not
// change the scanner's probability or payout gates; it can veto/re-rank a pick.
const { app } = require('@azure/functions');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_MODEL || 'gpt-6.2-astra';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const LEAGUE_PATH = { NBA: 'basketball/nba', NFL: 'football/nfl', MLB: 'baseball/mlb' };

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['KEEP', 'REJECT', 'REVIEW'] },
    matchupGrade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
    probabilityYes: { type: 'number' },
    confidence: { type: 'number' },
    defensiveAssessment: { type: 'string' },
    defensiveInjuries: { type: 'array', items: { type: 'string' } },
    offensiveAvailability: { type: 'string' },
    reasoning: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    missingData: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict','matchupGrade','probabilityYes','confidence','defensiveAssessment','defensiveInjuries','offensiveAvailability','reasoning','risks','missingData'],
};

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
async function espnJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('ESPN HTTP ' + response.status + ' for ' + url);
  return response.json();
}
function flattenTeams(data) {
  const out = [];
  for (const sport of data.sports || []) for (const league of sport.leagues || []) {
    for (const item of league.teams || []) if (item.team) out.push(item.team);
  }
  for (const item of data.teams || []) out.push(item.team || item);
  return out;
}
function findTeam(teams, name) {
  const wanted = norm(name);
  return teams.find(t => norm(t.displayName) === wanted || norm(t.name) === wanted || norm(t.shortDisplayName) === wanted)
    || teams.find(t => norm(t.displayName).includes(wanted) || wanted.includes(norm(t.displayName)));
}
function competitorScore(c) {
  const n = Number(String(c.score ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function scheduleDefence(events, opponentId) {
  const allowed = [];
  const games = [];
  for (const event of events || []) {
    const comp = event.competitions?.[0];
    const competitors = comp?.competitors || [];
    const opponent = competitors.find(c => String(c.id || c.team?.id) === String(opponentId) || String(c.team?.id) === String(opponentId));
    if (!opponent || competitors.length < 2) continue;
    const other = competitors.find(c => c !== opponent);
    const pointsAllowed = competitorScore(other);
    const pointsScored = competitorScore(opponent);
    if (pointsAllowed == null || pointsScored == null) continue;
    allowed.push(pointsAllowed);
    games.push({ date: event.date || comp.date || null, opponent: other.team?.displayName || other.team?.name || 'Unknown', pointsAllowed, pointsScored, result: pointsScored > pointsAllowed ? 'W' : 'L' });
  }
  const recent = games.slice(-10);
  const avg = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  return {
    gamesSampled: games.length,
    seasonPointsAllowed: avg(allowed),
    recentGames: recent,
    recentPointsAllowed: avg(recent.map(g=>g.pointsAllowed)),
    recentWins: recent.filter(g=>g.result==='W').length,
  };
}
function injuryList(data) {
  const items = data.injuries || data.items || data.entries || [];
  return items.map(item => {
    const athlete = item.athlete || item.player || {};
    const status = item.status || item.type?.description || item.details?.type || 'status unavailable';
    const detail = item.details?.detail || item.shortComment || item.longComment || item.description || '';
    return { player: athlete.displayName || athlete.fullName || item.name || 'Unknown player', position: athlete.position?.abbreviation || athlete.position?.name || '', status: String(status), detail: String(detail).slice(0,240) };
  }).slice(0,40);
}
async function fetchTeamEvidence(league, teamName, season) {
  const path = LEAGUE_PATH[league];
  const teamsData = await espnJson(ESPN + '/' + path + '/teams?limit=1000');
  const team = findTeam(flattenTeams(teamsData), teamName);
  if (!team?.id) throw new Error('Could not resolve ESPN team: ' + teamName);
  const base = ESPN + '/' + path + '/teams/' + team.id;
  const [scheduleResult, injuryResult] = await Promise.allSettled([
    espnJson(base + '/schedule?season=' + encodeURIComponent(season)),
    espnJson(base + '/injuries'),
  ]);
  const schedule = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
  const injuries = injuryResult.status === 'fulfilled' ? injuryList(injuryResult.value) : [];
  const events = schedule?.events || schedule?.team?.events || [];
  return {
    team: { id: team.id, name: team.displayName || team.name || teamName },
    defense: schedule ? scheduleDefence(events, String(team.id)) : null,
    injuries,
    scheduleError: scheduleResult.status === 'rejected' ? scheduleResult.reason.message : null,
    injuryError: injuryResult.status === 'rejected' ? injuryResult.reason.message : null,
    source: 'ESPN public team schedule and injuries endpoints',
    fetchedAt: new Date().toISOString(),
  };
}
function outputText(response) {
  for (const item of response.output || []) if (item.type === 'message') {
    for (const part of item.content || []) if (part.type === 'output_text') return part.text;
  }
  throw new Error('OpenAI returned no structured interrogation');
}
async function interrogate(input) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const instructions = `
You are the final matchup-risk reviewer for AngelicGTrader. This is a second-stage challenge of a candidate that already passed the existing scanner. Do not change or reinterpret the scanner's original qualification gates; decide whether matchup evidence is strong enough to retain the candidate.

PRIORITY ORDER:
1. Opponent defensive strength from actual ESPN schedule results: points allowed across season and most recent ten games. Defensive performance matters more than either team's raw points-per-game average.
2. Defensive personnel availability: injuries, absences, suspensions, and status uncertainty among defensive players. Do not infer that an injured player is a defender unless the supplied position/role supports it.
3. Offensive availability of the candidate team, especially when candidate side is YES. Check supplied injury/availability evidence; do not invent lineups.
4. Only then consider team scoring PPG and recent offensive production as secondary context.

SIDE-SPECIFIC:
- YES: demand credible offensive availability and a favorable opponent defense. Strong opponent defense, low points allowed, or key defensive players available are material reasons to REJECT even if the scoring team's PPG is high.
- NO: demand credible evidence that the opponent can suppress the candidate team's scoring: strong opponent defense and/or material offensive absences on the candidate team. Reverse the YES logic.
- Never treat a high PPG alone as a safe matchup. A team repeatedly scoring over a threshold does not prove it can do so against an elite defense.
- Explicitly flag mismatch cases such as a team with high PPG facing an opponent consistently holding teams below the selected line.
- Missing ESPN schedule or injury data must lower confidence. If critical defensive evidence is missing, verdict must be REVIEW, not KEEP.
- Prefer avoiding embarrassing matchup losses over finding a marginally attractive price. KEEP only when the matchup case is genuinely sound. REJECT clearly unfavorable matchups. REVIEW when evidence is incomplete.
- Treat the season-piece instruction as a user hypothesis/preferences, not factual evidence. Address it directly and disagree when the data warrants.
- probabilityYes is a revised independent estimate, 0..1, based on matchup evidence. Do not anchor to market price or original model probability.
Return only the required JSON object.`.trim();
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, instructions, input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: 'final_matchup_interrogation', strict: true, schema } },
      max_output_tokens: 1800,
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('OpenAI HTTP ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
  if (data.status !== 'completed') throw new Error('OpenAI response incomplete: ' + data.status);
  return { result: JSON.parse(outputText(data)), responseId: data.id };
}

app.http('FinalInterrogation', {
  methods: ['POST','OPTIONS'],
  authLevel: 'anonymous',
  route: 'FinalInterrogation',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
    try {
      const body = await request.json();
      const { candidate, market, teamStats, opponentStats } = body;
      if (!candidate || !market || !teamStats || !opponentStats) return { status: 400, headers: CORS, jsonBody: { error: 'candidate, market, teamStats, and opponentStats are required' } };
      const league = String(market.league || candidate.league || '').toUpperCase();
      if (!LEAGUE_PATH[league]) return { status: 422, headers: CORS, jsonBody: { error: 'league must be NBA, NFL, or MLB' } };
      const season = Number(body.season) || new Date().getFullYear();
      const [opponentEvidenceResult, teamEvidenceResult] = await Promise.allSettled([
        fetchTeamEvidence(league, market.opponent || opponentStats.name, season),
        fetchTeamEvidence(league, market.team || teamStats.name, season),
      ]);
      const evidence = {
        opponentDefense: opponentEvidenceResult.status === 'fulfilled' ? opponentEvidenceResult.value : { error: opponentEvidenceResult.reason.message, defense: null, injuries: [] },
        candidateTeamAvailability: teamEvidenceResult.status === 'fulfilled' ? teamEvidenceResult.value : { error: teamEvidenceResult.reason.message, defense: null, injuries: [] },
      };
      const input = {
        candidate,
        market: { ...market, side: candidate.side },
        baselineModel: { prediction: body.baselinePrediction || null, teamStatistics: teamStats, opponentStatistics: opponentStats },
        seasonPieceInstruction: String(body.pieceInstruction || '').slice(0,2000),
        espnEvidence: evidence,
        instruction: 'Assess opponent defense first. For YES, verify candidate offense is healthy and opponent defense is vulnerable or depleted. For NO, verify opponent defense is strong and/or candidate offense is depleted.',
      };
      const { result, responseId } = await interrogate(input);
      const missing = [...(result.missingData || [])];
      if (!evidence.opponentDefense.defense) missing.push('ESPN opponent schedule/defensive performance unavailable.');
      if (evidence.opponentDefense.injuryError) missing.push('ESPN opponent injury report unavailable.');
      if (!evidence.candidateTeamAvailability.injuries?.length && evidence.candidateTeamAvailability.injuryError) missing.push('ESPN candidate-team injury report unavailable.');
      if (missing.length && result.verdict === 'KEEP') result.verdict = 'REVIEW';
      return {
        status: 200, headers: CORS,
        jsonBody: {
          provider: 'OpenAI FinalInterrogation', model: MODEL, responseId,
          interrogatedAt: new Date().toISOString(), verdict: result.verdict,
          interrogation: result, evidence,
        },
      };
    } catch (error) {
      context.error('FinalInterrogation failed: ' + error.message);
      return { status: 502, headers: CORS, jsonBody: { error: error.message } };
    }
  },
});
