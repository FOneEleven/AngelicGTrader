# AngelicGTrader

Local-first Kalshi sports-market research and trading dashboard. Bets are staged in a shared Play Box and submitted together only when the user commits the box. Paper mode records simulated orders; live mode submits limit orders through Kalshi's V2 events-order API.

## Run locally

- Node.js 18+
- `npm install`
- `npm run dev`
- `npm test`
- `npm run build`

## Live data services

Azure Function App: `angelicgtrader-dvhgf4dhc6hahqhs`

| Function | Status | Purpose |
|---|---|---|
| `GET /api/GetKalshiMarkets` | Deployed and previously working | Reads current Kalshi sports markets through the existing Azure proxy. |
| `GET /api/GetTeamStatistics` | Deployed and tested | Retrieves NFL/NBA team and opponent statistics from free ESPN public endpoints. |
| `POST /api/AnalyzeMarket` | Deployed and tested | Sends market/statistics context to OpenAI Responses API and returns structured analysis. |
| `POST /api/KalshiAccount` (`action: orders`) | Requires updated Azure deployment | Decrypts the saved credential envelope in memory and submits Kalshi V2 orders; trade-write permission is required. |

OpenAI uses model `gpt-6.2-sol` in the current Azure configuration. The OpenAI API key is stored only in Azure Function App settings as `OPENAI_API_KEY`; the model is configured by `OPENAI_MODEL`. Never put either secret in this repository or a Vite `VITE_*` variable.

### Team statistics request

```
GET /api/GetTeamStatistics?league=NBA&team=Los%20Angeles%20Lakers&opponent=Boston%20Celtics&season=2026&seasontype=2
```

The tested v3 ESPN response includes `provider`, `league`, `season`, `seasonType`, `fetchedAt`, `team`, `opponent`, `modelInputs`, `recentGames`, and `dataQuality`. Team/opponent objects include identifiers, games played, PPG, points allowed, recent-five/recent-ten scoring, home/away splits, and wins/losses. Missing values remain null.

### AnalyzeMarket request

`POST /api/AnalyzeMarket` accepts `market`, `teamStats`, optional `opponentStats`, and optional `context`. It returns `prediction.probabilityYes`, expected team points, recommendation, confidence, reasoning, risks, missing-data notes, market-value calculations, and audit metadata.

The HTTP trigger's `function.json` is configured with `authLevel: "anonymous"`; the browser client therefore calls the function directly. The OpenAI API key remains server-side in Azure settings and is never sent to the browser. Because the endpoint is anonymous, protect it against abuse with Azure rate limits, usage monitoring, and an origin restriction before broad public deployment.

## AI Predictions pipeline

The AI Predictions screen uses the market entries already loaded into the existing market cache. It resolves the opposing team from the same event's team-total markets. Only Kalshi `occurrence_datetime` is accepted as the actual contest start; `close_time` and `expected_expiration_time` are contract lifecycle timestamps and are never substituted for kickoff. Started contests, missing occurrence times, and closed markets are excluded before statistics or AI interrogation. Each qualified contract receives its own final interrogation using its current ask and payout. The final interrogation applies +4 percentage points for evidence-backed meaningful team motivation, -6 points for a high-profile team with little at stake and credible low-urgency risk, and requires a verifiable opponent strength percentile from 10–40 (0 weakest, 100 strongest). Missing opponent-percentile evidence cannot receive KEEP. Rising payout during a contest is treated as possible liquidation/late-selling pressure, never as evidence of safety. The AI Predictions screen then:

1. Checks `meta/team-stats-cache.txt` before requesting ESPN. Cache keys include league, team, opponent, season, and season type; entries expire after six hours.
2. Supplies the cached/fetched ESPN team and opponent statistics to `POST /api/AnalyzeMarket` for every market line in each displayed entry.
3. Stores OpenAI responses in `meta/ai-analysis-cache.txt` for twelve hours. The cache key includes ticker, line, YES/NO asks, and the statistics timestamp.
4. Displays only the model probability and selected-side ask; raw team PPG and opponent PA remain internal model inputs.
5. Provides a per-entry YES/NO selector. YES displays `probabilityYes`; NO displays `1 - probabilityYes`. The slider automatically selects the lowest executable ask among lines at or above the 90% probability target. If no line reaches 90%, it selects the highest-probability available line and shows that it is below target. The slider remains manually adjustable.
6. Records paper predictions with the selected side, ask, model probability, source statistics, and AI reasoning.

The two caches are plain JSON text files under the user's connected data folder's `meta/` directory. Cache reads occur before network requests, so revisiting the page does not repeat fresh ESPN/OpenAI calls for unchanged inputs.

The 90% threshold is a selection target, not a guarantee of accuracy. OpenAI's estimate is contextual analysis and is not yet statistically calibrated. Model probability must be validated against historical, timestamp-correct outcomes before being used for stake sizing.


## Play Box and order submission

- Dashboard manual selections and the final AI selection are added to the persistent `meta/play-box.json` queue. Adding or removing an item does not create a trade or reserve stake.
- A season piece can have only one queued/committed selection per scheduled week. Its shared profile displays `IN PLAY BOX` while staged and `COMMITTED` after a confirmed submission.
- The Play Box blocks different lines or sides from the same team-total ladder. Identical ticker/side/line selections from multiple pieces are grouped into one order; the pieces retain separate allocation ledger rows with a shared order-group ID and the same resolution details.
- Paper commits record all piece allocations only after the user commits the box. Live commits sum allocations and submit one Kalshi V2 order per unique contract, using the saved executable ask as the limit price. YES maps to a bid; NO maps to an ask at the complementary YES-book price.
- Live orders require a connected Kalshi account whose API key has trade-write permission. An accepted Kalshi order is marked submitted; the API may return an order with remaining quantity that is still resting rather than fully filled. Failed order groups remain in the Play Box.
- The Azure `KalshiAccount` function must be deployed with the updated `action: orders` handler before live commits can work. Credentials remain encrypted at rest in the local data folder and are decrypted only in Azure memory.
- AI analysis runs only when **Start next week** is invoked on a season piece. After selection or failure, the view returns to Dashboard. Auto pieces lock app navigation while that scan is resolving.

## Backtesting foundation

`src/lib/backtesting.js` is a calculation foundation, not a completed historical backtesting product. Required rules:
- Fixed original stake every round; winnings tracked separately and never compounded.
- Each season ends on its first settled loss.
- Independent bets and multiple seasons may overlap the same market while retaining separate accounting.
- Aggregate shared market exposure for portfolio risk without merging the underlying positions.
- Store pre-event prediction timestamps, market asks, side, fees, model version, input statistics, source timestamps, verified results, and settlements.
- Never use data published after the event start in a historical prediction.

## Current development stage

1. **Connected services — working:** Kalshi, ESPN, and OpenAI endpoints have been manually tested.
2. **AI Predictions automatic data path — implemented in this PR update:** per-entry ESPN lookup, persistent metadata caching, per-line OpenAI analysis, YES/NO probability display, and 90% slider selection.
3. **Validation — next:** run the frontend against the deployed Azure functions; verify opponent matching, response fields, probabilities, cache hits, and failures on real NBA/NFL markets.
4. **Probability calibration and strategy — pending:** historical score distributions, calibrated probabilities, fee-aware EV, and out-of-sample tests.
5. **Backtesting and portfolio UI — pending:** historical replay, seasons, independent positions, settlement ingestion, exposure aggregation, ROI, and calibration reports.

No live order execution is implemented.


## Season match resolution

The frontend checks unresolved committed season-piece contracts every 60 seconds while the app window is open. The public `GetKalshiMarkets` Azure Function now supports `?action=resolve&tickers=...` to read definitive Kalshi market settlement results. Live pieces also use the `KalshiAccount` `order-status` action to verify filled contract counts before calculating a payout.

A winning settlement adds the contract payout to the piece's saved `currentWorth`, clears its selected game, and advances its scheduled week. A losing settlement deactivates the piece and snapshots its current worth plus participated matches in `meta/inactive-pieces.json`. Game Day displays active pieces in a horizontal carousel and the inactive archive separately.

Deploy the updated `GetKalshiMarkets` and `KalshiAccount` Azure Functions as well as publishing the frontend. The resolution monitor uses the connected Kalshi account to verify live fills; paper contracts are calculated from their saved stake and entry price. Unplayed pieces with no resolved win are normalized back to `week1`.
