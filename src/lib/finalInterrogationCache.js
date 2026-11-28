// Persistent seven-minute cache for eligible Final Interrogation matchup reviews.
import { META } from './dataFolder';

const FILE = 'final-interrogation-cache.txt';
export const FINAL_INTERROGATION_TTL_MS = 7 * 60 * 1000;

function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
async function readCache(root) {
  try {
    const dir = await root.getDirectoryHandle(META, { create: true });
    const file = await dir.getFileHandle(FILE);
    const parsed = JSON.parse(await (await file.getFile()).text() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
async function writeCache(root, cache) {
  const dir = await root.getDirectoryHandle(META, { create: true });
  const file = await dir.getFileHandle(FILE, { create: true });
  const writer = await file.createWritable();
  await writer.write(JSON.stringify(cache, null, 2) + '\n');
  await writer.close();
}
export async function getCachedFinalInterrogation(root, input) {
  if (!root) return null;
  const cache = await readCache(root);
  const entry = cache[fingerprint(input)];
  if (!entry?.cachedAt || !entry?.data) return null;
  const age = Date.now() - Date.parse(entry.cachedAt);
  return Number.isFinite(age) && age >= 0 && age <= FINAL_INTERROGATION_TTL_MS ? entry.data : null;
}
export async function setCachedFinalInterrogation(root, input, data) {
  if (!root) return;
  const cache = await readCache(root);
  cache[fingerprint(input)] = { cachedAt: new Date().toISOString(), data };
  const cutoff = Date.now() - FINAL_INTERROGATION_TTL_MS;
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.cachedAt || Date.parse(entry.cachedAt) < cutoff) delete cache[key];
  }
  await writeCache(root, cache);
}
