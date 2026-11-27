// Persistent OpenAI analysis cache in meta/ai-analysis-cache.txt.
import { META } from './dataFolder';

const FILE = 'ai-analysis-cache.txt';
export const AI_ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000;

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
export async function readAnalysisCache(root) {
  const text = await readText(root);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
export async function getCachedAnalysis(root, key, maxAgeMs = AI_ANALYSIS_TTL_MS) {
  const cache = await readAnalysisCache(root);
  const entry = cache[key];
  if (!entry?.cachedAt || !entry?.data) return null;
  const age = Date.now() - Date.parse(entry.cachedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? entry : null;
}
export async function setCachedAnalysis(root, key, data) {
  const cache = await readAnalysisCache(root);
  cache[key] = { cachedAt: new Date().toISOString(), data };
  await writeText(root, JSON.stringify(cache, null, 2) + '\n');
  return cache[key];
}
