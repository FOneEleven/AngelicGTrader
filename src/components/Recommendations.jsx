import React, { useEffect, useState } from 'react';
import { RefreshCw, PlusCircle, WalletCards } from 'lucide-react';
import { createSeasonProfile, listSeasonProfiles } from '../lib/dataModel';
import SeasonToken from './SeasonToken';

const PIECES = ['Quarterback', 'Running Back', 'Receiver', 'Lineman', 'Slam Dunk', 'Posterizer', 'Dribbler', '3Pt Shooter'];
const BASES = [
  { name: 'Royal Gold', color: '#c69d4e' }, { name: 'Sapphire', color: '#477fc5' },
  { name: 'Emerald', color: '#42966f' }, { name: 'Crimson', color: '#b94e55' },
  { name: 'Amethyst', color: '#8865bd' }, { name: 'Obsidian', color: '#777d8b' },
];
const EPITHETS = ['Golden', 'Rising', 'Iron', 'Velocity', 'Crowned', 'Untamed', 'Starlight', 'Victory'];
function randomFrom(items) { return items[Math.floor(Math.random() * items.length)]; }
function makeToken() {
  const pieceType = randomFrom(PIECES);
  const base = randomFrom(BASES);
  const nonce = Math.floor(1000 + Math.random() * 9000);
  return { pieceType, baseColor: base.color, baseName: base.name, nonce, name: randomFrom(EPITHETS) + ' ' + pieceType + ' · ' + nonce };
}

export default function Recommendations({ dataFolder, paperMode: currentPaperMode = true, onActivity }) {
  const root = dataFolder?.handle;
  const [balance, setBalance] = useState('100');
  const paperMode = currentPaperMode;
  const [token, setToken] = useState(makeToken);
  const [seasons, setSeasons] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (!root) return;
    listSeasonProfiles(root).then(setSeasons).catch((e) => setError(e.message || 'Could not load seasons'));
  }, [root]);

  function cyclePiece() { setToken(makeToken()); setCreated(null); }

  async function commitSeason() {
    const amount = Number(balance);
    if (!root) { setError('Connect a data folder first.'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a season balance greater than zero.'); return; }
    setBusy(true); setError('');
    try {
      const profile = await createSeasonProfile(root, {
        balance: amount, paperMode, pieceType: token.pieceType, baseColor: token.baseColor,
        baseName: token.baseName, nonce: token.nonce, name: token.name,
      });
      setSeasons((old) => [...old, profile]);
      setCreated(profile);
      setToken(makeToken());
      onActivity?.('SEASON_START', profile.name + ' created');
    } catch (e) { setError(e.message || 'Could not create season'); }
    finally { setBusy(false); }
  }

  return <div className="page-shell season-manager">
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>Season Manager</h1><p>Create a season, allocate its starting balance, and mint its collectible season piece.</p></div></div>
    {!root && <div className="notice"><div className="notice-icon"><WalletCards size={18}/></div><div><b>Connect a data folder</b><span>Season profiles and balances are saved locally.</span></div></div>}
    {error && <div className="notice error-notice"><b>{error}</b></div>}
    <section className="panel season-create-panel">
      <div className="panel-heading"><div><h2>Create a season</h2><p>Randomize the statue and base until you find the piece you want.</p></div><span className="status-pill">{paperMode ? 'PAPER SEASON' : 'LIVE SEASON'}</span></div>
      <div className="season-create-layout">
        <div className="season-token-preview">
          <div className="eyebrow">PREVIEW TOKEN</div>
          <SeasonToken pieceType={token.pieceType} baseColor={token.baseColor} size={176}/>
          <b>{token.name}</b><span>{token.baseName} base · nonce {token.nonce}</span>
          <button className="secondary-btn" onClick={cyclePiece} disabled={busy}><RefreshCw size={14}/> Cycle to another piece</button>
        </div>
        <div className="season-create-controls">
          <label htmlFor="season-balance">Starting season balance</label>
          <div className="season-balance-input"><span>$</span><input id="season-balance" type="number" min="0.01" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="100.00"/></div>
          <div className="season-mode-card"><span className={paperMode ? 'live-dot' : 'live-dot live'}></span><div><b>{paperMode ? 'Paper season' : 'Live season'}</b><small>Uses the current Paper/Live mode setting from the app header.</small></div></div>
          <div className="season-name-preview"><small>GENERATED SEASON NAME</small><b>{token.name}</b><span>Piece: {token.pieceType} · Base: {token.baseName}</span></div>
          <button className="primary-btn season-commit" disabled={!root || busy} onClick={commitSeason}><PlusCircle size={16}/>{busy ? 'Creating season…' : 'Commit season'}</button>
          {created && <div className="season-success">Created {created.name} · Season {created.season}</div>}
        </div>
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Created seasons · {seasons.length}</h2><p>Each committed token is retained as the identity of its season.</p></div></div>
      {seasons.length ? <div className="season-manager-list">{seasons.map((s) => <div className="season-manager-row" key={s.id}><SeasonToken pieceType={s.pieceType} baseColor={s.baseColor} size={68}/><div><b>{s.name}</b><span>Season {s.season} · <i>$</i>{Number(s.balance).toFixed(2)} · {s.paperMode ? 'Paper' : 'Live'}</span><small>{new Date(s.createdAt).toLocaleString()}</small></div></div>)}</div> : <div className="empty-state"><b>No seasons created yet</b><span>Your committed season tokens will be listed here.</span></div>}
    </section>
  </div>;
}
