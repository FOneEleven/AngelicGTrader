// Browser client for the Azure AnalyzeMarket function.
// The OpenAI API key remains exclusively in Azure Function App settings.
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
