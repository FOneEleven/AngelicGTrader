// Client helper for the deployed Azure GetTeamStatistics HTTP function.
// ESPN is accessed server-side by the Azure function; no browser API key is needed.
const BASE = import.meta.env.VITE_SPORTS_STATS_URL
  || 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/GetTeamStatistics';

export async function fetchTeamStatistics({
  league, team, opponent, season, seasonType = '2',
}) {
  if (!league || !team) throw new Error('league and team are required');

  const url = new URL(BASE);
  url.searchParams.set('league', String(league).toUpperCase());
  url.searchParams.set('team', team);
  if (opponent) url.searchParams.set('opponent', opponent);
  if (season != null && season !== '') url.searchParams.set('season', String(season));
  if (seasonType != null && seasonType !== '') url.searchParams.set('seasontype', String(seasonType));

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Team statistics request failed (${response.status})`);
  }
  return data;
}
