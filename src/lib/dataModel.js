// AngelicGTrader — season/week data model + activity log + paper trading.
import { WEEKS, META, ensureStructure } from './dataFolder';

const SEASON_PREFIX = 'season-';
const INDEX_FILE = 'index.txt';
const ACTIVITY_FILE = 'activity.txt';
const SETTINGS_FILE = 'settings.txt';
const AI_SELECTIONS_FILE = 'ai-prediction-selections.txt';

// --- Season discovery ---

export async function listSeasons(root) {
  const seasons = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue;
    const m = name.match(/^season-(\d+)$/);
    if (m) seasons.push(Number(m[1]));
  }
  return seasons.sort((a, b) => a - b);
}

export async function latestSeason(root) {
  const seasons = await listSeasons(root);
  return seasons.length ? seasons[seasons.length - 1] : 0;
}

// --- Low-level text helpers ---

async function writeText(dirHandle, filename, text) {
  const file = await dirHandle.getFileHandle(filename, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
}

async function readText(dirHandle, filename) {
  try {
    const file = await dirHandle.getFileHandle(filename);
    return await (await file.getFile()).text();
  } catch {
    return null;
  }
}

// --- Season / week creation ---

export async function createSeason(root, seasonNumber) {
  const seasonDir = await root.getDirectoryHandle(`${SEASON_PREFIX}${seasonNumber}`, { create: true });
  const now = new Date().toISOString();
  await writeText(seasonDir, 'season.txt',
    `# AngelicGTrader season\nseason: ${seasonNumber}\ncreated: ${now}\nstatus: active\n`);

  for (const week of WEEKS) {
    const weekDir = await seasonDir.getDirectoryHandle(week, { create: true });
    await writeText(weekDir, 'week.txt',
      `# AngelicGTrader week\nseason: ${seasonNumber}\nweek: ${week}\ncreated: ${now}\nstatus: open\n`);
  }
  return seasonNumber;
}

export async function ensureSeason(root, { forceNew = false } = {}) {
  const current = await latestSeason(root);
  if (!forceNew && current > 0) {
    return { season: current, created: false };
  }
  const next = current + 1;
  await createSeason(root, next);
  return { season: next, created: true };
}

// --- Index file ---

export async function writeIndex(root, { season, activeWeek = 'week1' }) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const now = new Date().toISOString();
  const text =
    `# AngelicGTrader index\n` +
    `updated: ${now}\n` +
    `active_season: ${season}\n` +
    `active_week: ${activeWeek}\n` +
    `weeks: ${WEEKS.join(',')}\n`;
  await writeText(metaDir, INDEX_FILE, text);
}

export async function readIndex(root) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, INDEX_FILE);
  if (!text) return null;
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m && !line.startsWith('#')) out[m[1]] = m[2].trim();
  }
  return out;
}

// --- Activity log ---

export async function appendActivity(root, type, message, options = {}) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const file = await metaDir.getFileHandle(ACTIVITY_FILE, { create: true });
  const existing = await (await file.getFile()).text().catch(() => '');
  const line = `${options.timestamp || new Date().toISOString()} | ${type} | ${message}\n`;
  const w = await file.createWritable();
  await w.write(existing + line);
  await w.close();
  return line.trim();
}

export async function readActivity(root, limit = 20) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, ACTIVITY_FILE);
  if (!text) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [timestamp, type, ...rest] = line.split(' | ');
      return { timestamp, type, message: rest.join(' | ') };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

// --- Paper mode settings ---

export async function readSettings(root) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, SETTINGS_FILE);
  const out = { paperMode: true };
  if (!text) return out;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m || line.startsWith('#')) continue;
    out[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2].trim();
  }
  return out;
}

export async function writeSettings(root, settings) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const lines = ['# AngelicGTrader settings', `updated: ${new Date().toISOString()}`];
  for (const [k, v] of Object.entries(settings)) lines.push(`${k}: ${v}`);
  await writeText(metaDir, SETTINGS_FILE, lines.join('\n') + '\n');
  return settings;
}

// --- Trade records ---

export async function appendTrade(root, season, week, trade) {
  const seasonDir = await root.getDirectoryHandle(`${SEASON_PREFIX}${season}`, { create: true });
  const weekDir = await seasonDir.getDirectoryHandle(week, { create: true });
  const filename = 'trades.txt';
  const file = await weekDir.getFileHandle(filename, { create: true });
  const existing = await (await file.getFile()).text().catch(() => '');
  const header = existing
    ? ''
    : '# id\ttimestamp\tmatchup\tmarket\tside\tprice\tprobability\tstake\tpaper\tstatus\tmetadata_json\n';
  const row = [
    trade.id,
    trade.timestamp,
    trade.matchup,
    trade.market,
    trade.side,
    trade.price,
    trade.probability,
    trade.stake,
    trade.paper ? 'paper' : 'live',
    trade.status || 'open',
    JSON.stringify({ strategy: trade.strategy ?? null, ticker: trade.ticker ?? null, line: trade.line ?? null, marketProbability: trade.marketProbability ?? null, modelProbability: trade.modelProbability ?? null, edge: trade.edge ?? null, modelVersion: trade.modelVersion ?? null, context: trade.context ?? null, reasoning: trade.reasoning ?? null, seasonPieceId: trade.seasonPieceId ?? null, week: trade.week ?? week, earnings: trade.earnings ?? null, profit: trade.profit ?? null, outcome: trade.outcome ?? null }),
  ].join('\t') + '\n';
  const w = await file.createWritable();
  await w.write(existing + header + row);
  await w.close();

  // Canonical append-only index used by the Dashboard Records panel.
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const recordsFile = await metaDir.getFileHandle('records.txt', { create: true });
  const recordsExisting = await (await recordsFile.getFile()).text().catch(() => '');
  const recordsWriter = await recordsFile.createWritable();
  await recordsWriter.write(recordsExisting + (recordsExisting ? '' : header) + row);
  await recordsWriter.close();
  return trade;
}

// Remove a record from every season/week file and the canonical Dashboard index.
export async function deleteTrade(root, tradeId) {
  if (!tradeId) return false;
  let removed = false;
  const seasons = await listSeasons(root);
  for (const season of seasons) {
    const seasonDir = await root.getDirectoryHandle(SEASON_PREFIX + season, { create: false });
    for (const week of WEEKS) {
      let weekDir;
      try { weekDir = await seasonDir.getDirectoryHandle(week, { create: false }); } catch { continue; }
      const text = await readText(weekDir, 'trades.txt');
      if (!text) continue;
      const lines = text.split('\n');
      const kept = lines.filter((line) => {
        if (!line || line.startsWith('#')) return true;
        const match = line.split('\t')[0] === tradeId;
        if (match) removed = true;
        return !match;
      });
      if (kept.length !== lines.length) await writeText(weekDir, 'trades.txt', kept.join('\n'));
    }
  }
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const records = await readText(metaDir, 'records.txt');
  if (records) {
    const lines = records.split('\n');
    const kept = lines.filter((line) => !line || line.startsWith('#') || line.split('\t')[0] !== tradeId);
    if (kept.length !== lines.length) { await writeText(metaDir, 'records.txt', kept.join('\n')); removed = true; }
  }
  return removed;
}

const SEASON_PROFILES_FILE = 'season-profiles.json';
export async function listSeasonProfiles(root) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, SEASON_PROFILES_FILE);
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed.map((profile) => ({ activePlayer: true, auto: false, strategy: 'midpoint', selectionStrategy: 'standard', quotaValue: Number(profile.balance) || 0, gridBand: 'pre-even', riskPreference: 'probability', diversityMode: 'allow-overlap', splitCount: 2, piecePrompt: '', nextScheduledWeek: 'week1', ...profile })).sort((a, b) => Number(a.season) - Number(b.season)) : []; } catch { return []; }
}

export async function createSeasonProfile(root, profile) {
  const season = (await latestSeason(root)) + 1;
  await createSeason(root, season);
  const createdAt = new Date().toISOString();
  const saved = { ...profile, season, id: 'season-' + season, createdAt, status: 'active', activePlayer: true, auto: false, strategy: profile.strategy || 'midpoint', selectionStrategy: profile.selectionStrategy || 'standard', quotaValue: Number(profile.quotaValue ?? profile.balance) || 0, gridBand: profile.gridBand || 'pre-even', riskPreference: profile.riskPreference || 'probability', diversityMode: profile.diversityMode || 'allow-overlap', splitCount: Number(profile.splitCount) || 2, piecePrompt: profile.piecePrompt || '', nextScheduledWeek: 'week1', name: profile.name || ('Season ' + season + '-' + profile.nonce) };
  const seasonDir = await root.getDirectoryHandle(SEASON_PREFIX + season, { create: false });
  await writeText(seasonDir, 'season-profile.json', JSON.stringify(saved, null, 2) + '\n');
  const profiles = await listSeasonProfiles(root);
  profiles.push(saved);
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  await writeText(metaDir, SEASON_PROFILES_FILE, JSON.stringify(profiles, null, 2) + '\n');
  await appendActivity(root, 'SEASON_START', saved.name + ' created · ' + (saved.paperMode ? 'Paper' : 'Live') + ' season');
  return saved;
}


export async function updateSeasonProfile(root, profileId, patch) {
  const profiles = await listSeasonProfiles(root);
  const index = profiles.findIndex((profile) => profile.id === profileId);
  if (index < 0) throw new Error('Season piece not found: ' + profileId);
  const updated = { ...profiles[index], ...patch, updatedAt: new Date().toISOString() };
  profiles[index] = updated;
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  await writeText(metaDir, SEASON_PROFILES_FILE, JSON.stringify(profiles, null, 2) + '\n');
  const seasonDir = await root.getDirectoryHandle(SEASON_PREFIX + updated.season, { create: true });
  await writeText(seasonDir, 'season-profile.json', JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

export async function readSeasonTrades(root, profile) {
  if (!profile) return [];
  const trades = [];
  for (const week of WEEKS) {
    const rows = await readTrades(root, profile.season, week);
    for (const trade of rows) {
      if (trade.seasonPieceId === profile.id) trades.push({ ...trade, week });
    }
  }
  return trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}


export async function splitSeasonPiece(root, profile, requestedCount) {
  const count = Math.max(2, Math.min(20, Math.floor(Number(requestedCount) || 0)));
  if (!profile?.id || !Number.isFinite(Number(profile.balance)) || Number(profile.balance) <= 0) {
    throw new Error('This piece has no available value to split.');
  }
  if (profile.splitInto?.length || profile.activePlayer === false) {
    throw new Error('This piece is already inactive or has already been split.');
  }

  const totalValue = Math.round(Number(profile.balance) * 100) / 100;
  const baseCents = Math.floor(totalValue * 100 / count);
  const remainder = Math.round(totalValue * 100) - baseCents * count;
  const children = [];

  for (let i = 0; i < count; i += 1) {
    const childCents = baseCents + (i < remainder ? 1 : 0);
    const childValue = childCents / 100;
    const child = await createSeasonProfile(root, {
      ...profile,
      id: undefined,
      season: undefined,
      balance: childValue,
      quotaValue: childValue,
      parentPieceId: profile.id,
      parentSeason: profile.season,
      splitIndex: i + 1,
      splitCount: count,
      splitInto: undefined,
      activePlayer: true,
      status: 'active',
      createdFromSplitAt: new Date().toISOString(),
      name: profile.name + ' · ' + (i + 1) + '/' + count,
    });
    children.push(child);
  }

  const updatedParent = await updateSeasonProfile(root, profile.id, {
    balance: 0,
    activePlayer: false,
    status: 'split',
    splitCount: count,
    splitInto: children.map((child) => child.id),
    splitAt: new Date().toISOString(),
  });

  return { parent: updatedParent, children };
}

export async function advanceSeasonWeek(root, profile) {
  const index = Math.max(0, WEEKS.indexOf(profile?.nextScheduledWeek || 'week1'));
  const nextScheduledWeek = WEEKS[Math.min(index + 1, WEEKS.length - 1)];
  return updateSeasonProfile(root, profile.id, { nextScheduledWeek });
}

export async function readTrades(root, season, week) {
  const seasonDir = await root.getDirectoryHandle(SEASON_PREFIX + season, { create: true });
  const weekDir = await seasonDir.getDirectoryHandle(week, { create: true });
  const text = await readText(weekDir, 'trades.txt');
  if (!text) return [];
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const fields = line.split('\t');
      const [id, timestamp, matchup, market, side, price, probability, stake, paper, status] = fields;
      let metadata = {};
      try { metadata = fields.length > 10 ? JSON.parse(fields.slice(10).join('\t')) : {}; } catch { /* retain legacy row */ }
      return { id, timestamp, matchup, market, side, price, probability, stake, paper: paper === 'paper', status, ...metadata };
    });
}

export async function tradeSummary(root, season, week) {
  const trades = await readTrades(root, season, week);
  return {
    total: trades.length,
    paper: trades.filter((t) => t.paper).length,
    live: trades.filter((t) => !t.paper).length,
  };
}

// --- Bootstrap ---

export async function bootstrapDataFolder(root) {
  await ensureStructure(root);
  const { season, created } = await ensureSeason(root, { forceNew: false });
  await writeIndex(root, { season, activeWeek: 'week1' });

  if (created) {
    await appendActivity(root, 'SEASON_START', `Season ${season} started`);
  }
  return { season, created };
}

// Persist ladders explicitly added from Live Market Scanner.
export async function readAIPredictionSelections(root) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, AI_SELECTIONS_FILE);
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []; }
  catch { return []; }
}

export async function writeAIPredictionSelections(root, selections) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const unique = [...new Set((selections || []).filter((v) => typeof v === 'string'))];
  await writeText(metaDir, AI_SELECTIONS_FILE, JSON.stringify(unique, null, 2) + '\n');
  return unique;
}


// Read the canonical record feed shared by every dashboard view.
export async function readAllRecords(root) {
  const metaDir = await root.getDirectoryHandle(META, { create: true });
  const text = await readText(metaDir, 'records.txt');
  if (!text) return [];
  return text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const fields = line.split('\t');
    const [id, timestamp, matchup, market, side, price, probability, stake, paper, status] = fields;
    let metadata = {};
    try { metadata = fields.length > 10 ? JSON.parse(fields.slice(10).join('\t')) : {}; } catch {}
    return { id, timestamp, matchup, market, side, price, probability, stake, paper: paper === 'paper', status, ...metadata };
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}
