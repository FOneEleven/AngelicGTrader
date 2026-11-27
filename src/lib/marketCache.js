// Persistent market cache stored in meta/market-cache.txt.
// One TSV line per market. Fetched batches are grouped by fetchedAt.
import { META } from './dataFolder';

const CACHE_FILE = 'market-cache.txt';
const MAX_AGE_MS = 60 * 60 * 1000;

async function readText(root) {
  const meta = await root.getDirectoryHandle(META, { create: true });
  try {
    const file = await meta.getFileHandle(CACHE_FILE);
    return await (await file.getFile()).text();
  } catch { return ''; }
}

async function writeText(root, text) {
  const meta = await root.getDirectoryHandle(META, { create: true });
  const file = await meta.getFileHandle(CACHE_FILE, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
}

const HEADER =
  '# fetchedAt\tticker\teventTicker\ttitle\tsubtitle\tstatus\tcloseTime\texpectedExpiration\toccurrenceTime\tlatestExpiration\topenInterest\tvolume24h\tvolume\tyesBid\tyesAsk\tnoBid\tnoAsk\tlastPrice\n';

function rowToMarket(fields) {
  const [
    fetchedAt, ticker, eventTicker, title, subtitle, status,
    closeTime, expectedExpiration, occurrenceTime, latestExpiration,
    openInterest, volume24h, volume, yesBid, yesAsk, noBid, noAsk, lastPrice,
  ] = fields;
  return {
    fetchedAt,
    ticker, eventTicker, title, subtitle, status,
    closeTime: closeTime || '',
    expectedExpiration: expectedExpiration || '',
    occurrenceTime: occurrenceTime || '',
    latestExpiration: latestExpiration || '',
    openInterest: Number(openInterest) || 0,
    volume24h: Number(volume24h) || 0,
    volume: Number(volume) || 0,
    yesBid: Number(yesBid) || 0,
    yesAsk: Number(yesAsk) || 0,
    noBid: Number(noBid) || 0,
    noAsk: Number(noAsk) || 0,
    lastPrice: Number(lastPrice) || 0,
  };
}

function marketToRow(m, fetchedAt) {
  return [
    fetchedAt, m.ticker, m.eventTicker, m.title, m.subtitle, m.status,
    m.closeTime || '',
    m.expectedExpiration || '',
    m.occurrenceTime || '',
    m.latestExpiration || '',
    m.openInterest, m.volume24h, m.volume,
    m.yesBid, m.yesAsk, m.noBid, m.noAsk, m.lastPrice,
  ].join('\t');
}

export async function readCache(root) {
  const text = await readText(root);
  if (!text) return { markets: [], fetchedAt: null };
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const markets = lines.map((l) => rowToMarket(l.split('\t')));
  const latest = markets.reduce((max, m) => (m.fetchedAt > max ? m.fetchedAt : max), '');
  return { markets, fetchedAt: latest || null };
}

export async function isCacheFresh(root) {
  const { fetchedAt } = await readCache(root);
  if (!fetchedAt) return false;
  return Date.now() - new Date(fetchedAt).getTime() < MAX_AGE_MS;
}

export async function appendCacheBatch(root, markets) {
  const fetchedAt = new Date().toISOString();
  const existing = await readText(root);
  const base = existing || HEADER;
  const rows = markets.map((m) => marketToRow(m, fetchedAt)).join('\n') + '\n';
  await writeText(root, base + rows);
  return fetchedAt;
}

export async function clearCache(root) {
  await writeText(root, HEADER);
}

export async function listCacheBatches(root) {
  const { markets } = await readCache(root);
  return [...new Set(markets.map((m) => m.fetchedAt))].sort().reverse();
}

export async function marketsFromBatch(root, fetchedAt) {
  const { markets } = await readCache(root);
  return markets.filter((m) => m.fetchedAt === fetchedAt);
}