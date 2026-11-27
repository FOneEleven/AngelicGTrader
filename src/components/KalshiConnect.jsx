import React, { useEffect, useState } from 'react';
import { ShieldCheck, Wallet, RefreshCw, Link2, Unlink, AlertCircle } from 'lucide-react';
import { appendActivity } from '../lib/dataModel';

const API = 'https://angelicgtrader-dvhgf4dhc6hahqhs.westus3-01.azurewebsites.net/api/KalshiAccount';
const META_FILE = 'kalshi-connection.json';
const AZURE_ENCRYPTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAstJrdd1Kke675amS/3WH
9snfIt9DD3ob6kJ8wybKg5YlgaBOcZOSsjAgCRi7VYgwTdE1FvSoLeOtNJxcZw96
r3qrost4cuJCsz9Gk/JXt5+Ugp7VFx8R7G2OE8xAI/iZjRxbjT/yvUvVXGEeG2p6
7712AakX0c67hYmv+4ynOMqrtd/KI61o4wGJGOww5/oPverNJKe7xU2ET0Pm6lH0
jbZlPFz2C2XRD09YAeqaeKlntNQI7w8Gyaz1AxfXrsCx5GqTX9KJVSkoyI+Kgpu1
jwT3qnPlpGTQ8NPeklrlWT8CP0CH81mLOeI6S3i8Tu/fApFstozsnUg1LQ3PyJG9
wv6OtUBRp+yQe04/WD9x29l9uUP2TNlaAa1FuP2bUS6sYptXRyyN6PmhF7JLHvka
4VwgoNOhzzHg8mV7UHEiAspZ26JYFLtKtMkB0aEDx0auYqQM6QPxpV38jHILOdZM
dteNKgGzXHSsDYNMkik+61Nv2doavPOMkwu8K8Me70a3AgMBAAE=
-----END PUBLIC KEY-----`;

function pemBytes(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
  const raw = atob(body);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function encryptCredential(publicPem, privateKeyPem) {
  const publicKey = await crypto.subtle.importKey(
    'spki', pemBytes(publicPem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
  );
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(privateKeyPem.trim()));
  const encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAesKey);
  return {
    encryptedKey: toBase64(new Uint8Array(encryptedKey)),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}
async function readConnection(root) {
  if (!root) return null;
  try {
    const dir = await root.getDirectoryHandle('meta');
    const file = await dir.getFileHandle(META_FILE);
    return JSON.parse(await (await file.getFile()).text());
  } catch { return null; }
}
async function saveConnection(root, value) {
  const dir = await root.getDirectoryHandle('meta', { create: true });
  const file = await dir.getFileHandle(META_FILE, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}
async function removeConnection(root) {
  const dir = await root.getDirectoryHandle('meta');
  await dir.removeEntry(META_FILE).catch(() => {});
}

export default function KalshiConnect({ dataFolderHandle, onAccountChange }) {
  const [saved, setSaved] = useState(null);
  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [nickname, setNickname] = useState('Kalshi Account');
  const [showForm, setShowForm] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const connection = await readConnection(dataFolderHandle);
      if (!cancelled) {
        setSaved(connection);
        if (connection?.nickname) setNickname(connection.nickname);
        if (connection?.keyId && connection?.envelope) {
          try { await verifyAndLoad(connection); }
          catch (e) { setError(e.message || 'Saved Kalshi connection could not be verified.'); }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [dataFolderHandle]);

  async function verifyAndLoad(connection) {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keyId: connection.keyId, envelope: connection.envelope }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.connected) throw new Error(result.error || 'Kalshi account verification failed.');
    setBalance(result);
    onAccountChange?.({ accountName: connection.nickname || 'Kalshi Account', balanceDollars: result.balanceDollars, portfolioValueDollars: result.portfolioValueDollars });
    return result;
  }

  async function connect() {
    setError('');
    setNotice('');
    if (!dataFolderHandle) { setError('Connect your local data folder first.'); return; }
    if (!keyId.trim() || !privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
      setError('Enter the API Key ID and the complete Ed25519 private key PEM.');
      return;
    }
    setBusy(true);
    try {
      const envelope = await encryptCredential(AZURE_ENCRYPTION_PUBLIC_KEY, privateKey);
      const connection = {
        keyId: keyId.trim(),
        envelope,
        nickname: nickname.trim() || 'Kalshi Account',
        environment: 'production',
        connectedAt: new Date().toISOString(),
        encryption: 'RSA-OAEP-SHA256 + AES-256-GCM',
      };
      const result = await verifyAndLoad(connection);
      await saveConnection(dataFolderHandle, connection);
      setSaved(connection);
      try { await importKalshiHistory(connection); }
      catch (historyError) { setNotice('Account connected. Trade history import failed: ' + historyError.message); }
      setPrivateKey('');
      setKeyId('');
      setShowForm(false);
      setShowGuide(false);
      setNotice('Kalshi account connected.');
      setBalance(result);
    } catch (e) {
      setError(e.message || 'Could not connect to Kalshi.');
    } finally { setBusy(false); }
  }

  async function importKalshiHistory(connection) {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: 'history', keyId: connection.keyId, envelope: connection.envelope }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.fills)) throw new Error(result.error || 'Kalshi history import failed.');
    const meta = await dataFolderHandle.getDirectoryHandle('meta', { create: true });
    const file = await meta.getFileHandle('kalshi-history.json', { create: true });
    let store = { accounts: {} };
    try { store = JSON.parse(await (await file.getFile()).text()); } catch {}
    const accountId = connection.keyId;
    const previous = store.accounts?.[accountId] || { nickname: connection.nickname, importedFillIds: [], fills: [] };
    const seen = new Set(previous.importedFillIds || []);
    const fresh = result.fills.filter((fill) => {
      const id = String(fill.fill_id || fill.trade_id || fill.id || '');
      return id && !seen.has(id);
    });
    for (const fill of fresh) {
      const id = String(fill.fill_id || fill.trade_id || fill.id);
      seen.add(id);
      previous.fills.push(fill);
      const rawTime = fill.created_time || fill.created_at || fill.ts || fill.created_ts;
      let timestamp = new Date().toISOString();
      if (rawTime != null) {
        const parsed = typeof rawTime === 'number' ? new Date(rawTime * 1000) : new Date(rawTime);
        if (!Number.isNaN(parsed.getTime())) timestamp = parsed.toISOString();
      }
      const quantity = fill.count_fp ?? fill.count ?? fill.quantity ?? '?';
      const side = [fill.action, fill.side].filter(Boolean).join(' ');
      const price = fill.yes_price_dollars ?? fill.no_price_dollars ?? fill.yes_price ?? fill.no_price;
      const description = (connection.nickname || 'Kalshi') + ' · ' + (fill.ticker || 'Market') + ' · ' + side + ' ' + quantity + (price != null ? ' @ ' + price : '');
      await appendActivity(dataFolderHandle, 'KALSHI_FILL', description, { timestamp });
    }
    previous.nickname = connection.nickname || 'Kalshi Account';
    previous.importedFillIds = Array.from(seen);
    previous.lastSyncedAt = new Date().toISOString();
    previous.apiResponses = result.apiResponses || [];
    store.accounts = { ...(store.accounts || {}), [accountId]: previous };
    const writer = await file.createWritable();
    await writer.write(JSON.stringify(store, null, 2));
    await writer.close();
    setNotice('Kalshi account connected. Imported ' + fresh.length + ' new fills.');
    return fresh.length;
  }
  async function refresh() {
    if (!saved) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await verifyAndLoad(saved);
      await importKalshiHistory(saved);
    } catch (e) { setError(e.message || 'Could not refresh Kalshi balance.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!dataFolderHandle) return;
    await removeConnection(dataFolderHandle);
    setSaved(null); setBalance(null); setError(''); setNotice('Local Kalshi connection removed. You can also revoke the API key in Kalshi settings.');
  }

  return <section className="kalshi-connect">
    <div className="kalshi-connect-head">
      <div className="kalshi-connect-title"><span className="kalshi-connect-icon"><Wallet size={19}/></span><div><h2>Kalshi account</h2><p>{saved ? 'Connected account' : 'Connect your Kalshi account'}</p></div></div>
      {saved ? <span className="kalshi-connected"><i/> Connected</span> : <span className="kalshi-disconnected">Not connected</span>}
    </div>
    {saved && balance ? <div className="kalshi-account-summary">
      <div><small>ACCOUNT</small><b>{saved.nickname || 'Kalshi Account'}</b><span>{balance.environment === 'demo' ? 'Demo account' : 'Production account'}</span></div>
      <div className="kalshi-balance"><small>AVAILABLE BALANCE</small><strong>${Number(balance.balanceDollars || 0).toFixed(2)}</strong><span>Portfolio value: ${Number(balance.portfolioValueDollars || 0).toFixed(2)}</span></div>
      <button className="secondary-btn" onClick={refresh} disabled={busy}><RefreshCw size={14}/> Refresh</button>
      <button className="text-btn" onClick={disconnect}><Unlink size={14}/> Disconnect</button>
    </div> : saved ? <div className="kalshi-saved-row"><ShieldCheck size={17}/> Account connection saved. Refresh to verify the account and load its balance.<button className="secondary-btn" onClick={refresh} disabled={busy}>{busy ? 'Checking…' : 'Load balance'}</button></div> : <div className="kalshi-connect-actions">
      <button className="primary-btn" onClick={() => { setShowForm((v) => !v); setShowGuide(true); }} disabled={!dataFolderHandle}><Link2 size={15}/> Connect Kalshi</button>
      {!dataFolderHandle && <span>Connect the data folder first to save encrypted credentials locally.</span>}
      <button className="text-btn" onClick={() => setShowGuide((v) => !v)}>API key setup tutorial</button>
    </div>}
    {showGuide && <div className="kalshi-guide">
      <b>Creating the Kalshi API key</b>
      <ol>
        <li>Open <a href="https://kalshi.com/account/profile" target="_blank" rel="noreferrer">Kalshi account settings</a> and scroll to API Keys.</li>
        <li>Select <b>Create key</b>. Name it <b>AngelicGTrader</b>.</li>
        <li>Choose <b>Ed25519</b>. This is the key type this integration expects and the recommended signing algorithm.</li>
        <li>Use permissions that include account reads (balance) and, when we enable order placement, <b>trade write</b>.</li>
        <li>Save the Key ID and download the private key PEM. Kalshi only displays the private key once.</li>
      </ol>
    </div>}
    {showForm && <div className="kalshi-form">
      <label>Account label<input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Kalshi Account"/></label>
      <label>API Key ID<input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="Paste the Kalshi API Key ID"/></label>
      <label>Ed25519 private key<textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={5} placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" spellCheck="false"/></label>
      <div className="kalshi-form-actions"><button className="primary-btn" onClick={connect} disabled={busy}>{busy ? 'Verifying…' : 'Verify and save connection'}</button><button className="secondary-btn" onClick={() => { setShowForm(false); setPrivateKey(''); }}>Cancel</button></div>
    </div>}
    {error && <div className="kalshi-error"><AlertCircle size={15}/>{error}</div>}
    {notice && <div className="kalshi-notice"><ShieldCheck size={15}/>{notice}</div>}

  </section>;
}
