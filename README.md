# AngelicGTrader

Local-first Kalshi sports-market research dashboard. The application is paper-only: it does not place live orders.

## Run locally

- Node.js 18+
- `npm install`
- `npm run dev`
- `npm test`
- `npm run build`

## Live data services

The deployed Azure Function App is `angelicgtrader-dvhgf4dhc6hahqhs`.

| Function | Status | Purpose |
|---|---|---|
| `GET /api/GetKalshiMarkets` | Deployed and previously working | Reads current Kalshi sports markets through the existing Azure proxy. |
| `GET /api/GetTeamStatistics` | Deployed and tested | Retrieves NFL/NBA team and opponent statistics from free ESPN public endpoints. |
| `POST /api/AnalyzeMarket` | Deployed and tested | Sends market/statistics context to OpenAI Responses API and returns structured analysis. |

The OpenAI integration uses model `gpt-6.2-sol` in the current Azure configuration. The OpenAI API key is stored only in Azure Function App settings as `OPENAI_API_KEY`; the model is configured by `OPENAI_MODEL`. Never put either secret in this repository or a Vite `VITE_*` variable. The AnalyzeMarket HTTP trigger currently requires a Function key. Do not embed that key in browser code; use a secured server-side proxy before connecting it directly to the public frontend.

### Team statistics request

```
GET /api/GetTeamStatistics?league=NBA&team=Los%20Angeles%20Lakers&opponent=Boston%20Celtics&season=2026&seasontype=2
```

The response includes the provider, league, season/season type, fetch timestamp, team/opponent identifiers, season and recent scoring averages, home/away splits, win/loss totals, recent games, model inputs, and data-quality metadata. ESPN is a public upstream source; it does not require a paid provider key. Season selection must be explicit when backtesting and must not silently substitute a different season.

### Market analysis request

`POST /api/AnalyzeMarket` accepts a market snapshot and available statistics, then returns the model's probability estimate, expected team points, recommendation, confidence, reasoning, market-value calculation, and an audit snapshot. Treat this as contextual AI analysis, not a calibrated probability model. The model may state assumptions when historical variance or other inputs are unavailable. Those assumptions must remain visible and must not be represented as measured facts.

## Prediction model

The deterministic hybrid baseline is in `src/lib/hybridModel.js`. It estimates team-total probability from independent team scoring and opponent points-allowed inputs, with explicit optional adjustments. Market asks are compared with the independent estimate; market price must never be copied into model probability.

The baseline is not trained or calibrated yet. Its default score standard deviation is a modeling fallback, not a measured team-specific variance. Before using probability or expected value for stake sizing, derive scoring distributions from timestamp-correct historical game data and validate calibration out of sample. Kalshi fees must be computed using the applicable exchange fee schedule and order size, not an arbitrary universal flat fee.

## Backtesting foundation

`src/lib/backtesting.js` implements:
- Fixed stake every round; winnings are tracked separately and never compounded into the next round's stake.
- Each season stops on its first settled loss.
- Independent bets and multiple seasons can overlap the same market while retaining separate allocation records.
- Portfolio exposure can be grouped by market and side without merging the underlying positions.
- Chronological replay of settled predictions.

This is a calculation foundation, not yet a complete historical backtesting product. A valid backtest needs archived pre-event market prices, model inputs and predictions timestamped before each game, verified results/settlements, and no look-ahead leakage.

## Current development stage

1. **Connected services — working:** Kalshi market proxy, ESPN statistics endpoint, and OpenAI AnalyzeMarket endpoint have each been tested by the developer.
2. **Frontend data orchestration — in progress:** load live market data, resolve team/opponent identities, fetch ESPN statistics automatically, and pass a consistent snapshot into analysis. The current prediction screen still has manual PPG fields.
3. **Strategy and probability validation — pending:** historical score distributions, recent-form weighting, calibrated probabilities, Kalshi fee-aware EV, and out-of-sample testing.
4. **Backtesting and portfolio UI — pending:** seasons, independent bets, settlement ingestion, exposure aggregation, ROI and calibration reports.

No live order execution is implemented.
