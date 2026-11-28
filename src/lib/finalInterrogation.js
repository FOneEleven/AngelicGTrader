// Browser client for the Azure FinalInterrogation function.
const BASE = import.meta.env.VITE_FINAL_INTERROGATION_URL
  || 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/FinalInterrogation';

export async function finalInterrogateCandidate({ candidate, market, teamStats, opponentStats, baselinePrediction, pieceInstruction, season }) {
  if (!candidate || !market || !teamStats || !opponentStats) {
    throw new Error('candidate, market, teamStats, and opponentStats are required');
  }
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, market, teamStats, opponentStats, baselinePrediction, pieceInstruction, season }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'FinalInterrogation failed (' + response.status + ')');
  if (!data.interrogation || !['KEEP', 'REJECT', 'REVIEW'].includes(data.verdict)) {
    throw new Error('FinalInterrogation returned an invalid review');
  }
  return data;
}
