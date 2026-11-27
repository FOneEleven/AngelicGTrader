# AngelicGTrader

Local-first Kalshi sports-market research dashboard. The current implementation remains paper-only: it does not place live orders.

## Run
- Node.js 18+
- `npm install`
- `npm run dev`
- `npm run build`

## Hybrid prediction engine

The engine has two distinct layers:

1. **Quantitative market screen:** existing cliff detection and midpoint fallback identify candidate team-total lines from the Kalshi YES-ask ladder.
2. **Independent scoring model:** estimates a team's score distribution from team points per game and opponent points allowed, then applies explicit optional adjustments for recent form, injuries, weather, and pace. It calculates model probability and edge against the executable YES ask.

The prediction UI exposes team PPG and opponent points allowed inputs for each team. If those independent inputs are missing, model probability and edge display as unavailable; the engine does not copy market odds into the model probability. The probability model is a transparent baseline, not an AI-trained model or a guarantee of accuracy.

## Recorded prediction audit trail
New paper records preserve strategy, ticker, selected line, market probability, independent model probability (when available), edge, model version, input context, and a short explanation. Existing ten-column TSV trade records remain readable.

## Not implemented yet
- Automated sports data research/provider integration
- Injury/weather feeds and verified source timestamps
- Automated event result retrieval and Kalshi settlement reconciliation
- Performance/ROI dashboards and probability calibration
- Live order execution

Do not treat an unpopulated model estimate or sample UI data as a real prediction.


## Backtesting foundation

`src/lib/backtesting.js` implements fixed-stake seasons, first-loss termination, separate accumulated profit, chronological replay of settled predictions, and shared market exposure aggregation. A season's stake does not compound: every round risks the original starting stake. Separate seasons and independent positions may allocate to the same market while retaining separate records.

Run the unit tests with `npm test`. These tests are committed but have not yet been executed in this GitHub-only editing session.

## Azure Functions

- Existing market proxy: `GET /api/GetKalshiMarkets` (see `src/lib/kalshi.js`).
- New statistics function: `GET /api/GetTeamStatistics` (see `azure-functions/GetTeamStatistics/index.js`).
- Frontend helper: `src/lib/sportsStats.js`.
- Deployment/configuration contract: `docs/AZURE_FUNCTIONS_AND_BACKTESTING.md`.

The statistics function is a provider-normalizing proxy. It requires `SPORTS_STATS_API_URL` and optionally `SPORTS_STATS_API_KEY` in the Azure Function App settings. The actual upstream ESPN/provider adapter is not yet confirmed or implemented; do not deploy expecting it to return data until that setting points to an adapter returning the documented normalized fields.

Next planned endpoint: `POST /api/AnalyzeMarket`, using server-side `OPENAI_API_KEY`.
