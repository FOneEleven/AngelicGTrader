# Azure Functions integration contract

## Existing function
The frontend currently calls the existing market proxy:

- Function name: `GetKalshiMarkets`
- Route: `GET /api/GetKalshiMarkets`
- Frontend reference: `src/lib/kalshi.js`
- Base URL currently configured in that file:
  `https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/GetKalshiMarkets`

The Azure Function source itself is not in this repository, so its runtime and deployment project still need to be confirmed.

## New function 2: GetTeamStatistics

Create a second HTTP-triggered Azure Function with this exact function name and route:

- Function name: `GetTeamStatistics`
- Route: `GET /api/GetTeamStatistics`
- Auth level in the supplied Node v4 example: `function`
- Query parameters:
  - `league`: `NFL` or `NBA` (required)
  - `team`: provider team name or ID (required)
  - `opponent`: optional opponent name or ID
  - `season`: optional season identifier
  - `window`: `season` or provider-supported recent window (defaults to `season`)

Expected JSON response:
```json
{
  "league": "NFL",
  "team": "Buffalo Bills",
  "opponent": "Kansas City Chiefs",
  "season": "2026",
  "window": "season",
  "teamPointsPerGame": 24.8,
  "opponentPointsAllowedPerGame": 21.3,
  "recentPointsPerGame": 27.2,
  "recentOpponentPointsAllowedPerGame": 19.6,
  "gamesSampled": 11,
  "homePointsPerGame": 26.1,
  "awayPointsPerGame": 23.5,
  "offensiveRank": 8,
  "defensiveRank": 12,
  "source": "provider-name",
  "asOf": "2026-11-27T00:00:00.000Z"
}
```

Deploy the supplied Node.js v4 handler as `GetTeamStatistics`. Configure these Function App environment variables:

- `SPORTS_STATS_API_URL`: the upstream statistics provider endpoint/adapter URL.
- `SPORTS_STATS_API_KEY`: optional provider key; stored server-side only.

**Provider adapter still required:** this repo does not contain the Azure source for `GetKalshiMarkets`, and the frontend search did not show an ESPN integration. We have not verified which ESPN endpoints or provider credentials the existing backend uses. The new handler deliberately normalizes a configured provider response rather than inventing an undocumented ESPN URL or fabricating statistics. Once you provide the existing Azure Function project/source or identify the upstream provider, wire that adapter to return the documented fields. Missing required PPG fields produce HTTP 422 rather than made-up numbers.

Example browser request (use your actual function host and function key):
```
GET https://<your-function-app>.azurewebsites.net/api/GetTeamStatistics?code=<function-key>&league=NFL&team=Buffalo%20Bills&opponent=Kansas%20City%20Chiefs&season=2026&window=season
```

## Function 3 (next): AnalyzeMarket

Planned exact name and route: `POST /api/AnalyzeMarket`. It will receive a market snapshot plus the normalized statistics above and return a structured, auditable AI analysis. The OpenAI key will be an Azure Function App setting named `OPENAI_API_KEY`; never put it in Vite/browser environment variables.

## Backtesting contract

- Each season has its own fixed stake, independent of prior wins.
- A season ends on its first settled loss.
- Net profits are accumulated separately; they are not rolled into later stakes.
- Independent bets and separate seasons may allocate to the same market/side.
- Each allocation remains a separate record; portfolio reporting groups them to show combined market exposure.
- Only timestamped pre-event predictions and verified settled outcomes can be used in a historical backtest.
- A game/result must not be used to generate a prediction that is then evaluated against that same game (no look-ahead leakage).
- The current code is a simulation foundation, not a verified historical backtest dataset or live order system.
