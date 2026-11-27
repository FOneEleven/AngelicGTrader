// MLB team-run context: MLB Stats API + Open-Meteo forecast.
// Runs in the browser; both providers are public endpoints and require no API key.
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

async function getJson(url, label) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(label + ' request failed (' + response.status + ')');
  return response.json();
}
function keyName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function findTeam(teams, name) {
  const key = keyName(name);
  return teams.find((t) => keyName(t.name) === key || keyName(t.abbreviation) === key)
    || teams.find((t) => keyName(t.name).includes(key) || key.includes(keyName(t.name)) || keyName(t.abbreviation).includes(key));
}
function statSplit(payload, type) {
  const rows = payload?.stats || [];
  const split = rows.flatMap((row) => row.splits || []).find((item) => item.stat);
  return split?.stat || null;
}
function n(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function perGame(stat, field) {
  const games = n(stat?.gamesPlayed);
  const total = n(stat?.[field]);
  return games > 0 && total != null ? total / games : null;
}
function isoDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('MLB game time is missing or invalid.');
  return date.toISOString().slice(0, 10);
}
function sameMatch(game, team, opponent) {
  const home = keyName(game.teams?.home?.team?.name);
  const away = keyName(game.teams?.away?.team?.name);
  const a = keyName(team), b = keyName(opponent);
  return ((home === a || home.includes(a) || a.includes(home)) && (away === b || away.includes(b) || b.includes(away)))
    || ((home === b || home.includes(b) || b.includes(home)) && (away === a || away.includes(a) || a.includes(home)));
}
async function teamStats(teamId, group, season, split) {
  const url = new URL(MLB_API + '/teams/' + teamId + '/stats');
  url.searchParams.set('stats', split);
  url.searchParams.set('group', group);
  url.searchParams.set('season', String(season));
  const data = await getJson(url.toString(), 'MLB ' + group + ' statistics');
  return statSplit(data, split);
}
async function fetchWeather(latitude, longitude, date, gameDateTime) {
  const url = new URL(WEATHER_API);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,wind_speed_10m,wind_direction_10m,weather_code');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'mm');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('start_date', date);
  url.searchParams.set('end_date', date);
  const data = await getJson(url.toString(), 'MLB weather forecast');
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  if (!times.length) throw new Error('Weather provider returned no hourly forecast for game day.');
  const target = new Date(gameDateTime).getTime();
  let index = 0, distance = Infinity;
  times.forEach((time, i) => {
    const d = Math.abs(new Date(time.endsWith('Z') ? time : time + 'Z').getTime() - target);
    if (d < distance) { distance = d; index = i; }
  });
  const value = (field) => n(hourly[field]?.[index]);
  const temperatureF = value('temperature_2m');
  const humidity = value('relative_humidity_2m');
  const precipitationProbability = value('precipitation_probability');
  const precipitationMm = value('precipitation');
  const windMph = value('wind_speed_10m');
  const windDirectionDegrees = value('wind_direction_10m');
  const weatherCode = value('weather_code');
  const heavyRainCode = [65, 67, 82].includes(weatherCode);
  const rainoutRisk = heavyRainCode || (
    precipitationProbability != null && precipitationProbability >= 70 &&
    precipitationMm != null && precipitationMm >= 1
  );
  return {
    source: 'Open-Meteo',
    forecastFor: times[index],
    temperatureF, humidityPercent: humidity,
    precipitationProbability, precipitationMm,
    windMph, windDirectionDegrees, weatherCode,
    rainoutRisk,
    coldForHitting: temperatureF != null && temperatureF < 55,
    highHumidity: humidity != null && humidity >= 80,
  };
}

export async function fetchMLBTeamStatistics({ team, opponent, gameTime }) {
  if (!team || !opponent || !gameTime) throw new Error('MLB requires team, opponent, and scheduled game time.');
  const date = isoDate(gameTime);
  const year = Number(date.slice(0, 4));
  const currentYear = new Date().getFullYear();
  const season = year > currentYear ? currentYear : year;
  const teamsPayload = await getJson(MLB_API + '/teams?sportId=1&season=' + season, 'MLB teams');
  const teams = teamsPayload.teams || [];
  const teamRow = findTeam(teams, team);
  const opponentRow = findTeam(teams, opponent);
  if (!teamRow || !opponentRow) throw new Error('Could not match both MLB teams to official MLB team IDs.');

  const dateOffsets = [0, -1, 1];
  let game = null;
  for (const offset of dateOffsets) {
    const scheduleDate = new Date(new Date(date + 'T12:00:00Z').getTime() + offset * 86400000).toISOString().slice(0, 10);
    const scheduleUrl = new URL(MLB_API + '/schedule');
    scheduleUrl.searchParams.set('sportId', '1');
    scheduleUrl.searchParams.set('date', scheduleDate);
    scheduleUrl.searchParams.set('hydrate', 'team,venue,probablePitcher');
    const schedule = await getJson(scheduleUrl.toString(), 'MLB schedule');
    const games = (schedule.dates || []).flatMap((row) => row.games || []);
    game = games.find((row) => sameMatch(row, team, opponent));
    if (game) break;
  }
  if (!game) throw new Error('MLB schedule has no matching game on ' + date + '.');

  const [hitting, recentHitting, opponentPitching, recentOpponentPitching] = await Promise.all([
    teamStats(teamRow.id, 'hitting', season, 'season'),
    teamStats(teamRow.id, 'hitting', season, 'lastXGames').catch(() => null),
    teamStats(opponentRow.id, 'pitching', season, 'season'),
    teamStats(opponentRow.id, 'pitching', season, 'lastXGames').catch(() => null),
  ]);
  if (!hitting || !opponentPitching) throw new Error('MLB provider did not return the required season hitting/pitching statistics.');

  const venue = game.venue || {};
  const coordinates = venue.location?.defaultCoordinates || {};
  if (!Number.isFinite(Number(coordinates.latitude)) || !Number.isFinite(Number(coordinates.longitude))) {
    throw new Error('MLB venue coordinates are unavailable; weather screening cannot be completed.');
  }
  const scheduledTime = game.gameDate || gameTime;
  const weather = await fetchWeather(coordinates.latitude, coordinates.longitude, date, scheduledTime);
  const teamRunsPerGame = perGame(hitting, 'runs');
  const opponentRunsAllowedPerGame = perGame(opponentPitching, 'runs');
  if (teamRunsPerGame == null || opponentRunsAllowedPerGame == null) {
    throw new Error('MLB statistics are missing team runs-per-game or opponent runs-allowed-per-game.');
  }

  const probablePitcher = game.teams?.home?.team?.id === teamRow.id
    ? game.teams?.away?.probablePitcher
    : game.teams?.home?.probablePitcher;
  const teamRecentRuns = recentHitting ? perGame(recentHitting, 'runs') : null;
  const opponentRecentRunsAllowed = recentOpponentPitching ? perGame(recentOpponentPitching, 'runs') : null;
  const stats = {
    league: 'MLB',
    season,
    provider: 'MLB Stats API',
    team: {
      id: teamRow.id, name: teamRow.name,
      pointsPerGame: teamRunsPerGame,
      recent5PPG: teamRecentRuns,
      runsPerGame: teamRunsPerGame,
      recentRunsPerGame: teamRecentRuns,
      battingAverage: hitting.avg || null,
      onBasePercentage: hitting.obp || null,
      sluggingPercentage: hitting.slg || null,
      ops: hitting.ops || null,
      homeRunsPerGame: perGame(hitting, 'homeRuns'),
      gamesPlayed: n(hitting.gamesPlayed),
    },
    opponent: {
      id: opponentRow.id, name: opponentRow.name,
      pointsAllowedPerGame: opponentRunsAllowedPerGame,
      runsAllowedPerGame: opponentRunsAllowedPerGame,
      recentRunsAllowedPerGame: opponentRecentRunsAllowed,
      era: opponentPitching.era || null,
      whip: opponentPitching.whip || null,
      gamesPlayed: n(opponentPitching.gamesPlayed),
    },
    modelInputs: {
      teamRunsPerGame, teamRecentRunsPerGame: teamRecentRuns,
      opponentRunsAllowedPerGame, opponentRecentRunsAllowedPerGame: opponentRecentRunsAllowed,
      probableStartingPitcher: probablePitcher?.fullName || null,
    },
    recentGames: [],
    dataQuality: {
      teamGamesSampled: n(hitting.gamesPlayed),
      opponentGamesSampled: n(opponentPitching.gamesPlayed),
      recentSampleAvailable: teamRecentRuns != null && opponentRecentRunsAllowed != null,
    },
    schedule: {
      gamePk: game.gamePk, gameTime: scheduledTime,
      venue: venue.name || null, homeTeam: game.teams?.home?.team?.name || null,
      awayTeam: game.teams?.away?.team?.name || null,
      probableStartingPitcher: probablePitcher?.fullName || null,
    },
    weather,
    fetchedAt: new Date().toISOString(),
  };
  return stats;
}
