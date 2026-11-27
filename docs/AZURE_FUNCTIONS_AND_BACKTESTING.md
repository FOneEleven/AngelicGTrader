# Azure Functions and backtesting contract

## Deployed Azure Function App

Function App: `angelicgtrader-dvhgf4dhc6hahqhs`

Base URL:
`https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net`

### 1. GetKalshiMarkets

- Route: `GET /api/GetKalshiMarkets`
- Status: deployed and previously tested.
- Purpose: fetches current Kalshi market snapshots through the existing Azure proxy.
- The original Azure source is maintained outside this repository.

### 2. GetTeamStatistics

- Route: `GET /api/GetTeamStatistics`
- Status: deployed and tested by the developer against NBA data.
- Upstream: free ESPN public site API; no ESPN API key or paid data provider is required.
- Runtime: the deployed function is Azure Functions v3 CommonJS using `module.exports = async function (context, req)` and `context.res`. Keep this runtime style when updating the deployed function. Do not replace it with Node.js v4 `app.http()` syntax in this Function App.

Query parameters:
- `league`: `NFL` or `NBA`.
- `team`: team name or ESPN team ID.
- `opponent`: optional team name or ESPN team ID.
- `season`: optional ESPN season year.
- `seasontype`: optional ESPN season type (for example `2` for regular season).

ESPN public endpoints used:
- NFL teams: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams`
- NFL team schedule: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{teamId}/schedule`
- NBA teams: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams`
- NBA team schedule: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{teamId}/schedule`

**Repository source parity warning:** the checked-in `azure-functions/GetTeamStatistics/index.js` is an older Node.js v4 provider-normalizing scaffold and is not the v3 ESPN implementation currently deployed and tested. Do not deploy that scaffold over the working Azure function. The next backend task is to port the verified deployed v3 ESPN source into this repository (including its `function.json`) and remove the obsolete v4 scaffold. The frontend client has been aligned to the tested query parameter names.\n\nThe tested response includes provider/league/season metadata; team and opponent identity; games played; season PPG and points allowed; recent-five and recent-ten PPG/PA; home/away scoring splits; wins/losses; recent game records; model inputs; and data-quality metadata.

Example:
```
GET https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/GetTeamStatistics?league=NBA&team=Los%20Angeles%20Lakers&opponent=Boston%20Celtics&season=2026&seasontype=2
```

Important season rule: an explicitly requested season must be preserved. A completed season must not be labeled as the current live season. Backtests must use the season and games that were available as of the prediction timestamp.

### 3. AnalyzeMarket

- Route: `POST /api/AnalyzeMarket`
- Status: deployed and successfully tested end-to-end.
- Provider: OpenAI Responses API.
- Model currently configured in Azure: `gpt-6.2-sol`.
- Azure Function App settings:
  - `OPENAI_API_KEY`: secret API key.
  - `OPENAI_MODEL`: model name.
- The function key is required by the current HTTP trigger. The key is not source code and must not be committed to GitHub or placed in a public Vite environment variable.
- OpenAI API billing is separate from a ChatGPT subscription.

The response observed in testing includes:
- provider/model, response ID, analyzed timestamp and duration;
- market snapshot;
- estimated YES probability and expected team points;
- recommendation and confidence;
- reasoning and historical-performance notes;
- market-value/expected-value section;
- audit metadata indicating whether probability was estimated independently from market price.

The LLM's estimate is contextual analysis, not a calibrated probability. If standard deviation, sample size, or historical hit rate is missing, the response must disclose that limitation. Do not treat an assumed score standard deviation as measured historical data.

**Frontend security:** do not send the Function key from browser code. The next secure integration step is a server-side authenticated proxy (or API Management) that calls AnalyzeMarket with the Function key kept server-side. No OpenAI key or Azure Function key needs to be added to GitHub.

## Frontend integration contract

- Kalshi client: `src/lib/kalshi.js`.
- ESPN client: `src/lib/sportsStats.js`.
- Hybrid quantitative baseline: `src/lib/hybridModel.js`.
- Prediction screen: `src/components/AIPredictions.jsx`.

The prediction screen currently exposes manual team PPG and opponent points-allowed fields. The next integration task is to map each Kalshi event/team to ESPN team IDs, fetch the matching season statistics automatically, and preserve the exact season type. Only after this data path is reliable should the screen call the secured AnalyzeMarket proxy.

## Backtesting rules

- Every season round risks the original starting stake. Prior winnings do not compound.
- The first settled loss stops that season only.
- Independent bets and separate seasons may allocate to the same market and side.
- Keep each allocation and settlement separate; aggregate shared market exposure for portfolio risk reporting.
- Record prediction timestamp, market ticker, executable entry ask, side, fees, model version, input statistics, source timestamps, and scheduled event start before the event.
- Store verified final results and settlement source/time separately.
- A prediction must never use information from after its event start.
- Do not treat current ESPN season averages or current Kalshi prices as historical pre-event snapshots.

The code in `src/lib/backtesting.js` is a simulation foundation, not a completed historical dataset or live trading engine.
