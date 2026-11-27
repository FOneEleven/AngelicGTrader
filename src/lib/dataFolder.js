// AngelicGTrader — local data folder via File System Access API.
// Supported: Chrome, Edge, Opera (Chromium). Firefox/Safari: unsupported.

const DB_NAME = 'angelicgtrader';
const STORE = 'handles';
const HANDLE_KEY = 'dataFolder';

export const WEEKS = ['week1', 'week2', 'week3'];
export const META = 'meta';

export function isSupported() {
  return typeof window !== 'undefined'
    && typeof window.showDirectoryPicker === 'function'
    && typeof window.isSecureContext === 'boolean'
    && window.isSecureContext;
}

// --- IndexedDB (persist the directory handle between visits) ---
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Public API ---

// Must be called from a user gesture (button click).
export async function pickDataFolder() {
  if (!isSupported()) {
    throw new Error('Folder access is not supported in this browser. Use Chrome, Edge, or Opera.');
  }
  const handle = await window.showDirectoryPicker({ id: 'angelicgtrader-data', mode: 'readwrite' });
  await ensureStructure(handle);
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

// Check for a previously saved folder without prompting.
export async function getSavedFolder() {
  const handle = await idbGet(HANDLE_KEY).catch(() => null);
  if (!handle) return null;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  return perm === 'granted' ? handle : { handle, needsPermission: true };
}

// Re-request permission on a saved folder (user gesture).
export async function requestSavedPermission(handle) {
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  return perm === 'granted' ? handle : null;
}

export async function ensureStructure(root) {
  for (const name of [...WEEKS, META]) {
    await root.getDirectoryHandle(name, { create: true });
  }
  const meta = await root.getDirectoryHandle(META, { create: true });
  const marker = await meta.getFileHandle('folder-init.txt', { create: true });
  const w = await marker.createWritable();
  await w.write(`# AngelicGTrader data folder\ninitialized: ${new Date().toISOString()}\n`);
  await w.close();
}

export async function writeWeekFile(root, week, filename, text) {
  if (!WEEKS.includes(week)) throw new Error(`Unknown week folder: ${week}`);
  if (!/^[\w.\-]+\.txt$/.test(filename)) throw new Error('Filename must be a simple .txt name');
  const dir = await root.getDirectoryHandle(week, { create: true });
  const file = await dir.getFileHandle(filename, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
  return `${week}/${filename}`;
}

export async function readWeekFile(root, week, filename) {
  if (!WEEKS.includes(week)) throw new Error(`Unknown week folder: ${week}`);
  const dir = await root.getDirectoryHandle(week);
  const file = await dir.getFileHandle(filename);
  return (await file.getFile()).text();
}

export async function listWeekFiles(root, week) {
  if (!WEEKS.includes(week)) throw new Error(`Unknown week folder: ${week}`);
  const dir = await root.getDirectoryHandle(week);
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.endsWith('.txt')) names.push(name);
  }
  return names.sort();
}

// Week bucketing: week1 = ISO week containing today, week2 = next, week3 = after.
export function bucketForDate(date, today = new Date()) {
  const iso = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() * 100 + Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  };
  const diff = iso(new Date(date)) - iso(today);
  return diff === 0 ? 'week1' : diff === 1 ? 'week2' : diff === 2 ? 'week3' : null;
}