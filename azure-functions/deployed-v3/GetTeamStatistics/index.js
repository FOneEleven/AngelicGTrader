const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

const LEAGUES = {
  NFL: ["football", "nfl"],
  NBA: ["basketball", "nba"]
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function espnFetch(url, validate = () => true) {
  let lastError;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 AngelicGTrader"
        }
      });

      if (!response.ok) {
        throw new Error("ESPN HTTP " + response.status);
      }

      const data = await response.json();

      if (!validate(data)) {
        throw new Error("Incomplete ESPN response");
      }

      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(1000 * (attempt + 1));
    }
  }

  throw lastError || new Error("ESPN request failed");
}

/*
 * ESPN's directory response contains league-level objects as well as teams.
 * A real team entry has displayName, abbreviation, and id. Requiring all
 * three prevents "Basketball" and "National Basketball Association" from
 * being treated as candidate teams.
 */
function findTeams(data) {
  const found = [];
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (
      value.id != null &&
      typeof value.displayName === "string" &&
      value.displayName.trim() &&
      typeof value.abbreviation === "string" &&
      value.abbreviation.trim()
    ) {
      const key = String(value.id);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(value);
      }
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else {
      for (const child of Object.values(value)) walk(child);
    }
  }

  walk(data);
  return found;
}

function uniqueTeams(teams) {
  const byId = new Map();
  for (const team of teams || []) {
    if (team && team.id != null) byId.set(String(team.id), team);
  }
  return [...byId.values()];
}

/*
 * Kalshi often shortens team names in market titles. These aliases map the
 * shortened label to ESPN's official team abbreviation. The match is still
 * validated against the live ESPN team directory before use.
 */
const TEAM_ALIASES = {
  NBA: {
    "losangelesc": "LAC",
    "losangelesclippers": "LAC",
    "clippers": "LAC",
    "lac": "LAC",
    "losangelesl": "LAL",
    "losangeleslakers": "LAL",
    "lakers": "LAL",
    "lal": "LAL",
    "goldenstate": "GS",
    "goldenstatewarriors": "GS",
    "warriors": "GS",
    "gs": "GS",
    "newyork": "NY",
    "newyorkknicks": "NY",
    "knicks": "NY",
    "ny": "NY",
    "brooklyn": "BKN",
    "brooklynnets": "BKN",
    "nets": "BKN",
    "bkn": "BKN",
    "memphis": "MEM",
    "memphisgrizzlies": "MEM",
    "grizzlies": "MEM",
    "mem": "MEM",
    "washington": "WSH",
    "washingtonwizards": "WSH",
    "wizards": "WSH",
    "wsh": "WSH",
    "neworleans": "NO",
    "neworleanspelicans": "NO",
    "pelicans": "NO",
    "no": "NO",
    "sanantonio": "SA",
    "sanantoniospurs": "SA",
    "spurs": "SA",
    "sa": "SA"
  },
  NFL: {
    "washington": "WSH",
    "washingtoncommanders": "WSH",
    "commanders": "WSH",
    "newyorkj": "NYJ",
    "newyorkjets": "NYJ",
    "nyjets": "NYJ",
    "nyj": "NYJ",
    "jets": "NYJ",
    "newyorkg": "NYG",
    "newyorkgiants": "NYG",
    "nygiants": "NYG",
    "nyg": "NYG",
    "giants": "NYG",
    "losangelesc": "LAC",
    "losangeleschargers": "LAC",
    "chargers": "LAC",
    "lac": "LAC",
    "losangelesr": "LAR",
    "losangelesrams": "LAR",
    "rams": "LAR",
    "lar": "LAR"
  }
};

function getTeamFields(team) {
  return [
    team.displayName,
    team.name,
    team.shortDisplayName,
    team.abbreviation,
    team.slug
  ].map(normalize).filter(Boolean);
}

function resolveAlias(league, requested, teams) {
  const aliases = TEAM_ALIASES[league] || {};
  const wanted = normalize(requested);
  const abbreviation = aliases[wanted];

  if (!abbreviation) return null;

  const matches = teams.filter(team =>
    normalize(team.abbreviation) === normalize(abbreviation)
  );

  return matches.length === 1 ? matches[0] : null;
}

function tokenPrefixMatch(candidate, wanted) {
  if (!candidate || !wanted) return false;
  if (candidate.startsWith(wanted)) return true;

  // Handles short city labels such as "New York J" against "New York Jets".
  const candidateTokens = String(candidate).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const wantedTokens = String(wanted).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  if (!wantedTokens.length || wantedTokens.length > candidateTokens.length) {
    return false;
  }

  return wantedTokens.every((token, index) =>
    candidateTokens[index] && candidateTokens[index].startsWith(token)
  );
}

async function resolveTeam(league, base, requested) {
  const directory = await espnFetch(
    base + "/teams?limit=1000",
    data => findTeams(data).length > 0
  );

  const teams = uniqueTeams(findTeams(directory));
  const wanted = normalize(requested);

  if (!teams.length) {
    throw new Error("ESPN returned no valid " + league + " team records");
  }

  // 1. Exact match against official ESPN names and abbreviations.
  const exact = teams.filter(team => getTeamFields(team).includes(wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error("ESPN exact team match is ambiguous: " + requested);
  }

  // 2. Explicit Kalshi-short-name aliases, validated against ESPN.
  const aliasMatch = resolveAlias(league, requested, teams);
  if (aliasMatch) return aliasMatch;

  // 3. Prefix/token matching for abbreviations not listed above.
  const prefix = teams.filter(team =>
    getTeamFields(team).some(field =>
      field.length > 2 && tokenPrefixMatch(field, String(requested))
    )
  );
  if (prefix.length === 1) return prefix[0];

  // 4. Unique substring match only; never pick the first arbitrary result.
  const partial = teams.filter(team =>
    getTeamFields(team).some(field =>
      field.length > 3 &&
      (field.includes(wanted) || wanted.includes(field))
    )
  );
  if (partial.length === 1) return partial[0];

  const candidates = uniqueTeams([...prefix, ...partial]).map(team => ({
    name: team.displayName,
    abbreviation: team.abbreviation,
    id: String(team.id)
  }));

  throw new Error(
    "ESPN team not found or ambiguous: " + requested +
    ". Candidates: " + JSON.stringify(candidates.slice(0, 12))
  );
}

function getCompletedGames(data, teamId) {
  const games = [];

  function getScore(score) {
    if (score && typeof score === "object") {
      return Number(score.value ?? score.displayValue);
    }
    return Number(score);
  }

  for (const event of data.events || []) {
    const competition = event.competitions && event.competitions[0];
    if (!competition) continue;

    const competitors = competition.competitors || [];
    const team = competitors.find(c => String(c.team && c.team.id) === String(teamId));
    const opponent = competitors.find(c => String(c.team && c.team.id) !== String(teamId));

    if (!team || !opponent) continue;

    const status = (competition.status && competition.status.type) ||
      (event.status && event.status.type);

    if (!status || status.completed !== true) continue;

    const scored = getScore(team.score);
    const allowed = getScore(opponent.score);

    if (!Number.isFinite(scored) || !Number.isFinite(allowed)) continue;

    games.push({
      eventId: String(event.id),
      date: event.date || null,
      opponent: (opponent.team && opponent.team.displayName) || "",
      opponentId: String((opponent.team && opponent.team.id) || ""),
      homeAway: team.homeAway || null,
      pointsScored: scored,
      pointsAllowed: allowed,
      result: scored > allowed ? "W" : scored < allowed ? "L" : "T"
    });
  }

  return games.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function avg(values) {
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

function summarize(games) {
  const recent5 = games.slice(-5);
  const recent10 = games.slice(-10);
  const home = games.filter(g => g.homeAway === "home");
  const away = games.filter(g => g.homeAway === "away");

  return {
    gamesPlayed: games.length,
    pointsPerGame: avg(games.map(g => g.pointsScored)),
    pointsAllowedPerGame: avg(games.map(g => g.pointsAllowed)),
    recent5PPG: avg(recent5.map(g => g.pointsScored)),
    recent5PointsAllowed: avg(recent5.map(g => g.pointsAllowed)),
    recent10PPG: avg(recent10.map(g => g.pointsScored)),
    recent10PointsAllowed: avg(recent10.map(g => g.pointsAllowed)),
    homePPG: avg(home.map(g => g.pointsScored)),
    awayPPG: avg(away.map(g => g.pointsScored)),
    wins: games.filter(g => g.result === "W").length,
    losses: games.filter(g => g.result === "L").length,
    ties: games.filter(g => g.result === "T").length
  };
}

async function getTeamData(league, base, requested, season, seasonType) {
  const team = await resolveTeam(league, base, requested);

  const url = new URL(base + "/teams/" + team.id + "/schedule");
  url.searchParams.set("season", season);
  url.searchParams.set("seasontype", seasonType);

  const schedule = await espnFetch(
    url.toString(),
    data => Array.isArray(data.events)
  );

  const games = getCompletedGames(schedule, team.id);

  return {
    team: {
      name: team.displayName,
      abbreviation: team.abbreviation,
      id: String(team.id)
    },
    games,
    stats: summarize(games)
  };
}

module.exports = async function (context, req) {
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS, body: "" };
    return;
  }

  try {
    const started = Date.now();
    const league = String(req.query.league || "NFL").toUpperCase();
    const config = LEAGUES[league];

    if (!config) {
      context.res = {
        status: 400,
        headers: CORS,
        body: JSON.stringify({ error: "league must be NFL or NBA" })
      };
      return;
    }

    const teamName = req.query.team;
    const opponentName = req.query.opponent || "";

    if (!teamName) {
      context.res = {
        status: 400,
        headers: CORS,
        body: JSON.stringify({ error: "team parameter is required" })
      };
      return;
    }

    const season = String(req.query.season || new Date().getFullYear());
    const seasonType = String(req.query.seasontype || "2");
    const recentLimit = Math.min(Math.max(Number(req.query.recent || 10), 1), 30);
    const base = ESPN + "/" + config[0] + "/" + config[1];

    context.log("GetTeamStatistics: " + league + " " + teamName);

    const teamData = await getTeamData(
      league, base, teamName, season, seasonType
    );

    if (!teamData.games.length) {
      context.res = {
        status: 503,
        headers: CORS,
        body: JSON.stringify({
          error: "No completed games returned by ESPN",
          retryable: true,
          team: teamName,
          resolvedTeam: teamData.team,
          season
        })
      };
      return;
    }

    let opponentData = null;
    if (opponentName) {
      opponentData = await getTeamData(
        league, base, opponentName, season, seasonType
      );
    }

    const opponentStats = opponentData ? opponentData.stats : null;

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        provider: "ESPN",
        league,
        season,
        seasonType,
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        team: Object.assign({}, teamData.team, teamData.stats),
        opponent: opponentData
          ? Object.assign({}, opponentData.team, opponentData.stats)
          : null,
        modelInputs: {
          teamPointsPerGame: teamData.stats.pointsPerGame,
          teamPointsAllowedPerGame: teamData.stats.pointsAllowedPerGame,
          recentTeamPPG: teamData.stats.recent10PPG,
          recentTeamPointsAllowed: teamData.stats.recent10PointsAllowed,
          opponentPointsAllowedPerGame: opponentStats
            ? opponentStats.pointsAllowedPerGame : null,
          opponentRecentPointsAllowed: opponentStats
            ? opponentStats.recent10PointsAllowed : null
        },
        recentGames: teamData.games.slice(-recentLimit).reverse(),
        dataQuality: {
          source: "ESPN",
          completedGames: teamData.games.length,
          opponentDataAvailable: !!opponentData,
          missingValuesAreNull: true
        }
      })
    };
  } catch (error) {
    context.log.error("GetTeamStatistics failed:", error);
    context.res = {
      status: 502,
      headers: CORS,
      body: JSON.stringify({
        error: error.message,
        provider: "ESPN",
        retryable: true
      })
    };
  }
};
