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
