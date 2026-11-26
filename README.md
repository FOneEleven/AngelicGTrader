# Kalshi AI Dashboard — starter

This is the first runnable browser dashboard shell. It is intentionally in **paper mode** and does not connect to Kalshi or place trades.

## Requirements
- Node.js 18 or newer
- npm

## Run locally
1. Extract this folder.
2. Open a terminal in the project folder.
3. Run `npm install`
4. Run `npm run dev`
5. Open the local URL printed by Vite (usually http://localhost:5173).

## Build check
Run `npm run build`.

## Current state
- Responsive React dashboard and navigation
- Dashboard overview and illustrative opportunity pipeline
- Placeholder pages for each planned module
- Paper-mode indicator
- No API keys, live data, or real-money trading

## Next implementation steps
1. Connect Kalshi market discovery (read-only).
2. Add sports schedules, standings, team scoring and injury data.
3. Implement stakes qualification and probability estimates.
4. Write immutable timestamped prediction records to TXT files.
5. Add paper-trading settlement and performance reports.
6. Generate manual betting recommendations with direct market links.

Do not treat sample rows or displayed probabilities as real predictions.
