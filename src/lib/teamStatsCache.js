// Persistent ESPN team statistics cache in meta/team-stats-cache.txt.
import { META } from './dataFolder';

const FILE = 'team-stats-cache.txt';
export const TEAM_STATS_TTL_MS = 6 * 60 * 60 * 1000;

async function readText(root) {
  const dir = await root.getDirectoryHandle(META, { create: true });
  try {
    const file = await dir.getFileHandle(FILE);
    return await (await file.getFile()).text();
  } catch { return ''; }
}
async function writeText(root, text) {
  const dir = await root.getDirectoryHandle(META, { create: true });
  const file = await dir.getFileHandle(FILE, { create: true });
  const writer = await file.createWritable();
  await writer.write(text);
  await writer.close();
}
export function teamStatsCacheKey({ league, team, opponent, season, seasonType = '2' }) {
  return [league, team, opponent || '', season || '', seasonType]
    .map((v) => String(v).trim().toLowerCase()).join('|');
}
export async function readTeamStatsCache(root) {
  const text = await readText(root);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
export async function getCachedTeamStats(root, key, maxAgeMs = TEAM_STATS_TTL_MS) {
  const cache = await readTeamStatsCache(root);
  const entry = cache[key];
  if (!entry?.fetchedAt || !entry.data) return null;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? entry : null;
}
export async function setCachedTeamStats(root, key, data) {
  const cache = await readTeamStatsCache(root);
  cache[key] = { fetchedAt: new Date().toISOString(), data };
  await writeText(root, JSON.stringify(cache, null, 2) + '\n');
  return cache[key];
}
