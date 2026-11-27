# Azure Functions and AI Predictions integration

## Deployed Azure Function App

Function App: `angelicgtrader-dvhgf4dhc6hahqhs`

Base URL:
`https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net`

### GetKalshiMarkets

- Route: `GET /api/GetKalshiMarkets`
- Status: deployed and previously tested.
- Purpose: fetch current Kalshi market snapshots through the existing Azure proxy.

### GetTeamStatistics

- Route: `GET /api/GetTeamStatistics`
- Status: deployed and tested against ESPN NBA data.
- Runtime: deployed Azure Functions v3 CommonJS. Preserve `module.exports = async function (context, req)` and `context.res`; do not replace it with v4 `app.http()` syntax.
- Query parameters: `league`, `team`, optional `opponent`, `season`, and `seasontype`.
- Upstream: free ESPN public API; no ESPN key required.

The verified response shape is:
- `provider`, `league`, `season`, `seasonType`, `fetchedAt`, `durationMs`
- `team` and `opponent` objects with `name`, `id`, `gamesPlayed`, `pointsPerGame`, `pointsAllowedPerGame`, `recent5PPG`, `recent5PointsAllowed`, `recent10PPG`, `recent10PointsAllowed`, `homePPG`, `awayPPG`, `wins`, `losses`, and `ties`
- `modelInputs`: `teamPointsPerGame`, `teamPointsAllowedPerGame`, `recentTeamPPG`, `recentTeamPointsAllowed`, `opponentPointsAllowedPerGame`, and `opponentRecentPointsAllowed`
- `recentGames`: event ID, date, opponent, opponent ID, home/away, points scored/allowed, and result
- `dataQuality`: source, completed games, opponent-data availability, and missing-value behavior

Example:
```
GET /api/GetTeamStatistics?league=NBA&team=Los%20Angeles%20Lakers&opponent=Boston%20Celtics&season=2026&seasontype=2
```

The checked-in `azure-functions/GetTeamStatistics/index.js` remains an older v4 scaffold and is not the verified deployed v3 ESPN implementation. Do not deploy it over the working Azure function. Porting the deployed v3 source and its `function.json` into the repository remains a separate backend parity task.

### AnalyzeMarket

- Route: `POST /api/AnalyzeMarket`
- Status: deployed and tested end-to-end with OpenAI Responses API.
- Azure app settings: `OPENAI_API_KEY` (secret) and `OPENAI_MODEL` (currently `gpt-6.2-sol`).
- The supplied `function.json` is configured as an anonymous HTTP trigger. No Function key is required by the frontend request.
- The OpenAI key remains server-side in Azure and must never be included in frontend code, Vite environment variables, or Git.

Request body:
```json
{
  "market": {
    "ticker": "market ticker",
    "title": "market title",
    "league": "NBA",
    "team": "team name",
    "opponent": "opponent name",
    "line": 110.5,
    "yesAsk": 0.52,
    "noAsk": 0.50,
    "closeTime": "ISO timestamp"
  },
  "teamStats": {},
  "opponentStats": {},
  "context": {}
}
```

The response exposes `prediction.probabilityYes` (0–1), expected team points, recommendation, confidence, reasoning, advantages, risks, missing data, market value, and audit metadata. NO probability is always derived as `1 - probabilityYes`; do not ask OpenAI to return an independent, contradictory NO probability.

Because the trigger is anonymous, it is publicly callable. Add Azure rate limiting/monitoring and appropriate CORS/origin restrictions before broad deployment. OpenAI billing is separate from a ChatGPT subscription.

## Frontend implementation in this PR update

- `src/components/AIPredictions.jsx`: retains the existing AI Predictions market entries, automatically finds the opponent from the same event's team-total markets, requests ESPN data, analyzes every line, removes manual PPG/PA controls, and shows model probability for the selected YES/NO side.
- `src/lib/sportsStats.js`: calls the deployed GetTeamStatistics query contract, including `seasontype`.
- `src/lib/analyzeMarket.js`: calls the anonymous AnalyzeMarket endpoint and validates `prediction.probabilityYes`.
- `src/lib/teamStatsCache.js`: persistent ESPN cache in `meta/team-stats-cache.txt`, keyed by league/team/opponent/season/seasonType, six-hour TTL.
- `src/lib/analysisCache.js`: persistent OpenAI cache in `meta/ai-analysis-cache.txt`, twelve-hour TTL.
- `src/lib/marketCache.js`: preserves absent asks as null rather than converting them to zero.

The YES/NO selector is per entry. The probability shown for NO is the complement of OpenAI's YES probability. The slider selects the lowest executable ask among lines whose selected-side model probability is at least 90%; if none qualify, it selects the highest-probability available line and visibly remains below the target. The user can manually move the slider.

## Backtesting rules (not part of this UI change)

- Each season round risks the original fixed stake; winnings do not compound.
- A season stops at its first settled loss.
- Independent positions and multiple seasons may overlap one market.
- Keep each position's accounting separate while aggregating market exposure for risk.
- Store pre-event model inputs, prices, prediction timestamp, model version, fees, result, and settlement source.
- Never leak post-event information into a historical prediction.

The existing backtesting module is a calculation foundation. A full historical backtesting UI and verified historical data pipeline remain pending.
