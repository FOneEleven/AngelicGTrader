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

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
        throw new Error(`ESPN HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!validate(data)) {
        throw new Error("Incomplete ESPN response");
      }

      return data;
    } catch (error) {
      lastError = error;

      if (attempt < 4) {
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

// ESPN team directory responses are nested.
// Walk the response and collect actual team objects.
function findTeams(data) {
  const found = [];
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (
      value.id &&
      (value.displayName || value.name) &&
      (value.abbreviation || value.slug)
    ) {
      const key = String(value.id);

      if (!seen.has(key)) {
        seen.add(key);
        found.push(value);
      }
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
    } else {
      Object.values(value).forEach(walk);
    }
  }

  walk(data);
  return found;
}

// ESPN's Washington franchise identifiers differ by league and are
// more stable than relying on a display-name substring.
function aliasesFor(base, requested) {
  const league = base.endsWith("/nfl") ? "NFL" :
    base.endsWith("/nba") ? "NBA" : "";
  const name = normalize(requested);

  if (league === "NFL" &&
      ["washington", "washingtoncommanders", "commanders"].includes(name)) {
    return ["washingtoncommanders", "commanders", "wsh", "was"];
  }

  if (league === "NBA" &&
      ["washington", "washingtonwizards", "wizards"].includes(name)) {
    return ["washingtonwizards", "wizards", "was"];
  }

  return [];
}

function uniqueTeams(teams) {
  const byId = new Map();
  for (const team of teams) {
    if (team?.id != null) byId.set(String(team.id), team);
  }
  return [...byId.values()];
}

async function resolveTeam(base, requested) {
  const directory = await espnFetch(
    `${base}/teams?limit=1000`,
    data => findTeams(data).length > 0
  );

  const teams = uniqueTeams(findTeams(directory));
  const wanted = normalize(requested);

  const fields = team => [
    team.displayName,
    team.name,
    team.shortDisplayName,
    team.abbreviation,
    team.slug
  ].map(normalize).filter(Boolean);

  // Prefer exact canonical display/name matches first.
  const exact = teams.filter(team => fields(team).includes(wanted));
  if (exact.length === 1) return exact[0];

  // Apply known league-specific aliases, e.g. NFL Washington -> WSH.
  const aliases = aliasesFor(base, requested).map(normalize);
  if (aliases.length) {
    const aliasMatches = teams.filter(team =>
      fields(team).some(value => aliases.includes(value))
    );
    if (aliasMatches.length === 1) return aliasMatches[0];

    // If several records match an alias, prefer an exact canonical name.
    const canonical = aliasMatches.filter(team =>
      normalize(team.displayName) === aliases[0] ||
      normalize(team.name) === aliases[0]
    );
    if (canonical.length === 1) return canonical[0];
  }

  // Last-resort partial matching, but never choose arbitrarily.
  const partial = teams.filter(team =>
    fields(team).some(candidate =>
      candidate.length > 2 &&
      (candidate.includes(wanted) || wanted.includes(candidate))
    )
  );

  const candidates = uniqueTeams([...exact, ...partial]);
  if (candidates.length === 1) return candidates[0];

  const candidateNames = candidates
    .map(team => `${team.displayName || team.name} [${team.abbreviation || team.id}]`)
    .slice(0, 8);

  throw new Error(
    `ESPN team not found or ambiguous: ${requested}` +
    (candidateNames.length ? `. Candidates: ${candidateNames.join(", ")}` : "")
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
    const competition = event.competitions?.[0];
    if (!competition) continue;

    const competitors = competition.competitors || [];

    const team = competitors.find(
      c => String(c.team?.id) === String(teamId)
    );

    const opponent = competitors.find(
      c => String(c.team?.id) !== String(teamId)
    );

    if (!team || !opponent) continue;

    const status = competition.status?.type ||
      event.status?.type;

    if (status?.completed !== true) continue;

    const scored = getScore(team.score);
    const allowed = getScore(opponent.score);

    if (!Number.isFinite(scored) ||
        !Number.isFinite(allowed)) continue;

    games.push({
      eventId: String(event.id),
      date: event.date || null,
      opponent: opponent.team?.displayName || "",
      opponentId: String(opponent.team?.id || ""),
      homeAway: team.homeAway || null,
      pointsScored: scored,
      pointsAllowed: allowed,
      result: scored > allowed ? "W" :
        scored < allowed ? "L" : "T"
    });
  }

  return games.sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );
}

function avg(values) {
  if (!values.length) return null;

  return Number((
    values.reduce((a, b) => a + b, 0) / values.length
  ).toFixed(2));
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

async function getTeamData(base, requested, season, seasonType) {
  const team = await resolveTeam(base, requested);

  const url = new URL(
    `${base}/teams/${team.id}/schedule`
  );

  url.searchParams.set("season", season);
  url.searchParams.set("seasontype", seasonType);

  const schedule = await espnFetch(
    url.toString(),
    data => Array.isArray(data.events)
  );

  const games = getCompletedGames(schedule, team.id);

  return {
    team: {
      name: team.displayName || team.name,
      id: String(team.id)
    },
    games,
    stats: summarize(games)
  };
}

module.exports = async function (context, req) {
  if (req.method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: CORS,
      body: ""
    };
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

    const season = String(
      req.query.season || new Date().getFullYear()
    );

    const seasonType = String(req.query.seasontype || "2");

    const recentLimit = Math.min(
      Math.max(Number(req.query.recent || 10), 1),
      30
    );

    const base = `${ESPN}/${config[0]}/${config[1]}`;

    context.log(`GetTeamStatistics: ${league} ${teamName}`);

    const teamData = await getTeamData(
      base, teamName, season, seasonType
    );

    if (!teamData.games.length) {
      context.res = {
        status: 503,
        headers: CORS,
        body: JSON.stringify({
          error: "No completed games returned by ESPN",
          retryable: true,
          team: teamName,
          season
        })
      };
      return;
    }

    let opponentData = null;

    if (opponentName) {
      opponentData = await getTeamData(
        base, opponentName, season, seasonType
      );
    }

    const opponentStats = opponentData?.stats || null;

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

        team: { ...teamData.team, ...teamData.stats },

        opponent: opponentData ? {
          ...opponentData.team,
          ...opponentData.stats
        } : null,

        modelInputs: {
          teamPointsPerGame: teamData.stats.pointsPerGame,
          teamPointsAllowedPerGame: teamData.stats.pointsAllowedPerGame,
          recentTeamPPG: teamData.stats.recent10PPG,
          recentTeamPointsAllowed: teamData.stats.recent10PointsAllowed,
          opponentPointsAllowedPerGame:
            opponentStats?.pointsAllowedPerGame ?? null,
          opponentRecentPointsAllowed:
            opponentStats?.recent10PointsAllowed ?? null
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
