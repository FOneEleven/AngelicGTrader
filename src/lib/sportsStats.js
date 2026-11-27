// Client helper for the Azure GetTeamStatistics HTTP function.
// The provider API key stays in Azure Function App Settings, never in Vite.
const BASE = import.meta.env.VITE_SPORTS_STATS_URL
  || 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/GetTeamStatistics';

export async function fetchTeamStatistics({ league, team, opponent, season, window = 'season' }) {
  if (!league || !team) throw new Error('league and team are required');
  const url = new URL(BASE);
  url.searchParams.set('league', league);
  url.searchParams.set('team', team);
  if (opponent) url.searchParams.set('opponent', opponent);
  if (season) url.searchParams.set('season', season);
  url.searchParams.set('window', window);

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Sports statistics request failed (${response.status})`);
  }
  return data;
}
