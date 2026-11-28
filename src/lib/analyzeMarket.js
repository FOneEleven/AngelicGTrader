// Browser client for the Azure AnalyzeMarket function.
// Sends up to five complete team-total ladders per OpenAI analysis request.
const BASE = import.meta.env.VITE_ANALYZE_MARKET_URL
  || 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/AnalyzeMarket';

export async function analyzeMarket({ market, teamStats, opponentStats, context = {}, pieceInstruction = '', baselinePrediction = null }) {
  if (!market || !teamStats) throw new Error('market and teamStats are required');
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ market, teamStats, opponentStats: opponentStats || null, context, pieceInstruction, baselinePrediction }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AnalyzeMarket failed (${response.status})`);
  const probabilityYes = Number(data.prediction?.probabilityYes);
  if (!Number.isFinite(probabilityYes) || probabilityYes < 0 || probabilityYes > 1) {
    throw new Error('AnalyzeMarket returned an invalid probabilityYes');
  }
  return data;
}

export async function analyzeMarketBatch(ladders) {
  if (!Array.isArray(ladders) || !ladders.length || ladders.length > 5) {
    throw new Error('AnalyzeMarket batch must contain between 1 and 5 complete ladders');
  }
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ladders }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AnalyzeMarket batch failed (${response.status})`);
  if (!Array.isArray(data.results)) throw new Error('AnalyzeMarket batch returned no results array');
  const byTicker = new Map(data.results.map((item) => [item.ticker, item.data]));
  for (const ladder of ladders) {
    for (const line of ladder.markets || []) {
      const result = byTicker.get(line.ticker);
      const probabilityYes = Number(result?.prediction?.probabilityYes);
      if (!result || !Number.isFinite(probabilityYes) || probabilityYes < 0 || probabilityYes > 1) {
        throw new Error('AnalyzeMarket batch omitted a valid result for ' + line.ticker);
      }
    }
  }
  return byTicker;
}
