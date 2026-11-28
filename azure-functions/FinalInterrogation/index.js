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
    teamPercentile: { type: ['number', 'null'] },
    teamPercentileRationale: { type: 'string' },
    opponentPercentile: { type: ['number', 'null'] },
    opponentPercentileRationale: { type: 'string' },
    startingQbAvailable: { type: ['boolean', 'null'] },
    startingQbRationale: { type: 'string' },
    defensiveAssessment: { type: 'string' },
    defensiveInjuries: { type: 'array', items: { type: 'string' } },
    offensiveAvailability: { type: 'string' },
    opposingOffenseAssessment: { type: 'string' },
    opposingOffenseInjuries: { type: 'array', items: { type: 'string' } },
    opposingOffenseAvailability: { type: 'string' },
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
    'teamPercentile', 'teamPercentileRationale',
    'opponentPercentile', 'opponentPercentileRationale',
    'startingQbAvailable', 'startingQbRationale',
    'defensiveAssessment', 'defensiveInjuries', 'offensiveAvailability',
    'opposingOffenseAssessment', 'opposingOffenseInjuries', 'opposingOffenseAvailability',
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

  // ESPN's Site scoreboard API no longer accepts date ranges; it returns HTTP 400.
  // Fetch each calendar day separately, then merge and deduplicate by event ID.
  const dates = [...new Set(ranges.flatMap(({ start, end }) => {
    const days = [];
    for (let day = start; day <= end; day = shiftDate(day, 1)) days.push(day);
    return days;
  }))];

  const results = await Promise.allSettled(dates.map(async (date) => {
    const url = new URL(ESPN_BASE + '/' + path + '/scoreboard');
    url.searchParams.set('dates', date.replace(/-/g, ''));
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
  if (!unique.size && failures.length === results.length) {
    throw new Error('ESPN scoreboard unavailable for ' + dates.length + ' daily requests: ' + failures.join('; '));
  }
  if (!unique.size && failures.length) {
    throw new Error('ESPN scoreboard returned no events; ' + failures.length + '/' + dates.length + ' daily requests failed: ' + failures.join('; '));
  }
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


const NFL_VENUE_COORDS=[['Arizona Cardinals',33.5276,-112.2626],['Atlanta Falcons',33.7554,-84.4008],['Baltimore Ravens',39.278,-76.6227],['Buffalo Bills',42.7738,-78.787],['Carolina Panthers',35.2258,-80.8528],['Chicago Bears',41.8623,-87.6167],['Cincinnati Bengals',39.0954,-84.516],['Cleveland Browns',41.5061,-81.6995],['Dallas Cowboys',32.7473,-97.0945],['Denver Broncos',39.7439,-105.0201],['Detroit Lions',42.34,-83.0456],['Green Bay Packers',44.5013,-88.0622],['Houston Texans',29.6847,-95.4107],['Indianapolis Colts',39.7601,-86.1639],['Jacksonville Jaguars',30.3239,-81.6373],['Kansas City Chiefs',39.0489,-94.4839],['Las Vegas Raiders',36.0909,-115.1833],['Los Angeles Chargers',33.9535,-118.3392],['Los Angeles Rams',33.9535,-118.3392],['Miami Dolphins',25.958,-80.2389],['Minnesota Vikings',44.9738,-93.2575],['New England Patriots',42.0909,-71.2643],['New Orleans Saints',29.9511,-90.0812],['New York Giants',40.8135,-74.0745],['New York Jets',40.8135,-74.0745],['Philadelphia Eagles',39.9008,-75.1675],['Pittsburgh Steelers',40.4468,-80.0158],['San Francisco 49ers',37.403,-121.97],['Seattle Seahawks',47.5952,-122.3316],['Tampa Bay Buccaneers',27.9759,-82.5033],['Tennessee Titans',36.1665,-86.7713],['Washington Commanders',38.9077,-76.8645]];
const NFL_INDOOR_VENUES=new Set(['Arizona Cardinals','Atlanta Falcons','Dallas Cowboys','Detroit Lions','Houston Texans','Indianapolis Colts','Las Vegas Raiders','Minnesota Vikings','New Orleans Saints']);
function findNflVenue(names){const n=(names||[]).map(normalizeName);return NFL_VENUE_COORDS.find(([team])=>n.some(x=>x===normalizeName(team)||normalizeName(team).includes(x)||x.includes(normalizeName(team))))||null;}
function nearestHourlyValue(times,values,targetIso){if(!Array.isArray(times)||!Array.isArray(values)||!targetIso)return null;const target=Date.parse(targetIso);if(!Number.isFinite(target))return null;let best=-1,d=Infinity;for(let i=0;i<times.length;i++){const delta=Math.abs(Date.parse(times[i]+'Z')-target);if(Number.isFinite(delta)&&delta<d){best=i;d=delta;}}return best>=0&&d<=5400000&&values[best]!=null?Number(values[best]):null;}
async function fetchGameWeather(league,event){
 if(league!=='NFL')return {available:false,reason:'Outdoor weather adjustment is configured for NFL only.',penaltyPoints:0};
 const venue=findNflVenue(event.homeTeam);if(!venue)return {available:false,reason:'Could not resolve NFL home venue.',penaltyPoints:0};
 if(NFL_INDOOR_VENUES.has(venue[0]))return {available:true,indoor:true,venue:venue[0],reason:'Indoor/covered venue; no outdoor weather penalty.',penaltyPoints:0};
 const url=new URL('https://api.open-meteo.com/v1/forecast');url.searchParams.set('latitude',String(venue[1]));url.searchParams.set('longitude',String(venue[2]));url.searchParams.set('hourly','temperature_2m,precipitation,rain,snowfall,precipitation_probability,wind_gusts_10m,weather_code');url.searchParams.set('forecast_days','7');url.searchParams.set('past_days','1');url.searchParams.set('timezone','UTC');
 const data=await fetchJson(url.toString(),12000),h=data.hourly||{},get=k=>nearestHourlyValue(h.time,h[k],event.eventStartTime);
 const tc=get('temperature_2m'),precip=get('precipitation'),rain=get('rain'),snow=get('snowfall'),gust=get('wind_gusts_10m'),code=get('weather_code'),tf=tc==null?null:tc*9/5+32,gm=gust==null?null:gust/1.609344;
 const ice=[56,57,66,67].includes(code),freezing=tf!=null&&tf<=32&&((precip||0)>0||(snow||0)>0||ice),heavyRain=!ice&&((rain||0)>=5||(precip||0)>=7.5||[65,82].includes(code));
 const windPenalty=gm==null||gm<25?0:gm>=30?5:2,heavyRainPenalty=heavyRain?2:0,freezingPenalty=freezing?5:0,icePenalty=ice?10:0,precipitationPenalty=ice?10:freezing?5:heavyRain?2:0;
 return {available:true,indoor:false,venue:venue[0],temperatureF:tf==null?null:Math.round(tf),windGustMph:gm==null?null:Math.round(gm),precipitationMm:precip,rainMm:rain,snowfallCm:snow,weatherCode:code,heavyRain,freezing,ice,windPenaltyPoints:windPenalty,heavyRainPenaltyPoints:heavyRainPenalty,freezingPenaltyPoints:freezingPenalty,icePenaltyPoints:icePenalty,precipitationPenaltyPoints:precipitationPenalty,penaltyPoints:windPenalty+precipitationPenalty,source:'Open-Meteo',forecastFor:event.eventStartTime};
}
async function fetchStartingQbContext(event){const url=new URL(ESPN_BASE+'/football/nfl/summary');url.searchParams.set('event',String(event.eventId));try{const d=await fetchJson(url.toString(),12000);return {source:'ESPN game summary',injuries:d.injuries||[],rosters:d.rosters||[],depthCharts:d.depthCharts||d.depthcharts||[],gameInfo:d.gameInfo||{}};}catch(e){return {source:'ESPN game summary',unavailable:true,reason:e.message||String(e)};}}

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
      teamPercentile: null,
      teamPercentileRationale: 'Not evaluated.',
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
  const weather = await fetchGameWeather(league, liveEvent).catch(e => ({available:false,reason:e.message||String(e),penaltyPoints:0}));
  const startingQbContext = league === 'NFL' ? await fetchStartingQbContext(liveEvent) : null;

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
      weather,
      startingQbContext,
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
      opponentStrengthMotivation: 'If BOTH team percentiles are >=78, apply -3 pp. If BOTH are <=64, apply +3 pp. Otherwise 0; unknown percentile means 0.',
      weatherMotivation: 'NFL ONLY. Weather is never a factor in NBA and must contribute exactly 0 pp for NBA. For NFL, use supplied game-time Open-Meteo data. Gusts 25–29 mph: 2 pp; 30 mph or higher: 5 pp of defensive-friendly adjustment. Precipitation severity is exclusive: heavy rain 2 pp, freezing precipitation 5 pp, ice/freezing rain 10 pp of defensive-friendly adjustment (use only the most severe applicable category). Stack precipitation with wind. Indoor stadium: 0 pp. Missing forecast: 0 and disclose unknown. These are positive adjustments to the NO side; when represented as probabilityYes, subtract them from YES probability, so NO receives the exact inverse positive benefit.',
      startingQuarterbackMotivation: 'Use supplied ESPN summary injury/roster/depth-chart evidence. If the team lacks its starting QB for this game, apply -12 pp. Only return false if evidence confirms the starter unavailable or no starter is designated. Unknown evidence means null and 0 pp; never guess.',
      objective: 'Serious, competitive contests with strong fantasy upside.',
    },
  };

  const instructions = `
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
- Compare the selected team's teamPercentile with the opponentPercentile. Percentiles are league-relative: 0 = weakest, 100 = strongest.
- If BOTH teams are at or above the 78th percentile (top 22%), apply -3 percentage points to motivation.
- If BOTH teams are at or below the 64th percentile (bottom 64%), apply +3 percentage points to motivation.
- If the teams fall outside those matching bands, apply 0 points.
- If either team's percentile is unknown, apply 0 points.
- These percentile bands affect motivation only. They MUST NOT determine or alter KEEP, REJECT, or REVIEW.
- Do not add missing percentile information to missingData; missing percentile alone is not a critical fact and MUST NOT cause REVIEW.
- Do not invent standings, playoff status, injuries, or motivation.
- motivationAssessment MUST explicitly record the conclusion, evidence, and exact adjustment, including "0 pp" and why when no adjustment applies. Do not leave it blank or merely say "motivation considered".
- Return baseProbabilityYes, motivationAdjustmentPoints, and adjusted probabilityYes.
- probabilityYes must equal clamp(baseProbabilityYes + adjustmentPoints / 100, 0, 1).

OPPONENT QUALITY AND MOTIVATION:
- Estimate BOTH selected-team teamPercentile and opponentPercentile from supplied league standings, record, efficiency, and season/recent statistics. 0 = weakest, 100 = strongest.
- Do not fabricate either percentile. If evidence is insufficient, use null and explain which percentile could not be established.
- If BOTH percentiles are >=78, motivationAdjustmentPoints must be -3.
- If BOTH percentiles are <=64, motivationAdjustmentPoints must be +3.
- Otherwise, or if either percentile is unknown, motivationAdjustmentPoints must be 0.
- Percentile bands affect motivation only. They are never a matchup eligibility gate and must never independently change the verdict.
- Missing percentile alone is not a critical missing fact, must not be listed in missingData, and MUST NOT cause REVIEW.

MATCHUP AND VERDICT:
- Assess normal rotation, competitive intensity, pace, scoring environment, usage/volume, recent form, and fantasy upside from supplied evidence.
- Do not invent player projections, injuries, standings, or rotation news.
- Evaluate startingQbAvailable from supplied ESPN summary. Return false only if the starting QB is confirmed unavailable; true if confirmed available; null if unverified. Explain in startingQbRationale.
- MATCHUP NOTES MUST FOLLOW THE CONTRACT SIDE. For selectedSide YES, populate defensiveAssessment and defensiveInjuries with the opposing defense's relevant evidence, and offensiveAvailability with the selected team's offensive availability. For selectedSide NO, populate opposingOffenseAssessment, opposingOffenseInjuries, and opposingOffenseAvailability with evidence about the opponent's offense. Do not substitute a defense review for a NO-side opposing-offense review. Use only supplied team/opponent statistics and ESPN game-summary evidence; if a fact is not verified, say so and leave injury arrays empty. Never infer an injury or availability status.
- Explicitly account for structured weather data only in NFL. NBA weather must have no effect on motivation or probability. In NFL, inclement weather is defensive-friendly: it increases NO probability and decreases YES probability by the same percentage points. Unavailable weather is unknown, not clear weather.
- KEEP when the matchup is acceptable, motivation/rotation is credible, fantasy upside is acceptable, grade is A or B, and no material missing fact undermines the decision. Opponent percentile is not a KEEP requirement.
- REJECT for material rotation/motivation risk or a poor matchup, not for opponent percentile alone.
- REVIEW when genuinely critical facts about the event or matchup cannot be verified.
- The scoreboard is the source of truth for event status. Market close and expiration are contract timestamps, not game-start evidence.
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
  let verdict = result.verdict;
  const baseProbabilityYes = Number(result.baseProbabilityYes);
  if (!Number.isFinite(baseProbabilityYes) || baseProbabilityYes < 0 || baseProbabilityYes > 1) {
    throw new Error('Final interrogation returned an invalid base probability.');
  }

  result.baseProbabilityYes = baseProbabilityYes;
  result.teamPercentile = result.teamPercentile != null && Number.isFinite(Number(result.teamPercentile)) && Number(result.teamPercentile) >= 0 && Number(result.teamPercentile) <= 100
    ? Number(result.teamPercentile) : null;
  result.opponentPercentile = result.opponentPercentile != null && Number.isFinite(Number(result.opponentPercentile)) && Number(result.opponentPercentile) >= 0 && Number(result.opponentPercentile) <= 100
    ? Number(result.opponentPercentile) : null;
  const teamRank = result.teamPercentile;
  const opponentRank = result.opponentPercentile;
  const percentileAdjustment = teamRank == null || opponentRank == null ? 0
    : teamRank >= 78 && opponentRank >= 78 ? -3
    : teamRank <= 64 && opponentRank <= 64 ? 3 : 0;
  result.startingQbAvailable = result.startingQbAvailable === true ? true : result.startingQbAvailable === false ? false : null;
  const quarterbackPenalty = league === 'NFL' && result.startingQbAvailable === false ? 12 : 0;
  const weatherPenalty = league === 'NFL' ? (Number(weather?.penaltyPoints) || 0) : 0;
  const expectedMotivationAdjustment = percentileAdjustment - weatherPenalty - quarterbackPenalty;
  result.motivationAdjustmentPoints = expectedMotivationAdjustment;
  result.probabilityYes = Math.max(0, Math.min(1, baseProbabilityYes + expectedMotivationAdjustment / 100));
  const percentileSummary = 'Selected team=' + (teamRank == null ? 'unknown' : teamRank) + 'th percentile; opponent=' + (opponentRank == null ? 'unknown' : opponentRank) + 'th percentile.';
  const weatherSummary = weather?.available ? (weather.indoor ? ' Indoor venue; no weather penalty.' : ' Gusts=' + (weather.windGustMph ?? 'unknown') + ' mph; heavy rain=' + !!weather.heavyRain + '; freezing=' + !!weather.freezing + '; ice=' + !!weather.ice + ' (−' + weatherPenalty + ' pp).') : ' Weather unavailable (' + (weather?.reason || 'no forecast') + '); no weather deduction applied.';
  const qbSummary = quarterbackPenalty ? ' Starting QB unavailable (−12 pp): ' + (result.startingQbRationale || 'ESPN summary evidence') + '.' : result.startingQbAvailable === true ? ' Starting QB confirmed available.' : ' Starting QB availability unverified; no QB deduction applied.';
  result.motivationAssessment = (percentileAdjustment > 0 ? '+' : '') + percentileAdjustment + ' pp percentile adjustment; ' + percentileSummary + weatherSummary + qbSummary + ' Total motivation adjustment=' + (expectedMotivationAdjustment > 0 ? '+' : '') + expectedMotivationAdjustment + ' pp.';

  // Percentile data is used only to calculate the motivation adjustment.
  // It is explicitly excluded from verdict and missing-data enforcement.
  result.missingData = (result.missingData || []).filter((item) =>
    !/percentile/i.test(String(item))
  );
  if (!['A', 'B'].includes(result.matchupGrade) && verdict === 'KEEP') verdict = 'REJECT';
  if (result.missingData.length && verdict === 'KEEP') verdict = 'REVIEW';

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
      teamPercentileMotivationBands: { top22Threshold: 78, bottom64Threshold: 64 },
      weather, weatherPenaltyPoints: weatherPenalty,
      startingQbAvailable: result.startingQbAvailable, startingQbRationale: result.startingQbRationale,
      startingQbPenaltyPoints: quarterbackPenalty, percentileAdjustmentPoints: percentileAdjustment,
      teamPercentile: result.teamPercentile,
      opponentPercentile: result.opponentPercentile,
      motivationAdjustmentPoints: expectedMotivationAdjustment,
      motivationAssessment: result.motivationAssessment,
      baseProbabilityYes,
      finalProbabilityYes: result.probabilityYes,
      motivationAdjustments: { bothTop22Points: -3, bothBottom64Points: 3, otherwisePoints: 0 },
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
