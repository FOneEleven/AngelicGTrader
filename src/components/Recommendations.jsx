import React, { useEffect, useState } from 'react';
import { RefreshCw, PlusCircle, WalletCards, Scissors } from 'lucide-react';
import { createSeasonProfile, listSeasonProfiles, updateSeasonProfile, splitSeasonPiece, readSeasonTrades, confirmedWalletReturns } from '../lib/dataModel';
import SeasonToken from './SeasonToken';
import SeasonPieceEntry from './SeasonPieceEntry';

const PIECES = ['Quarterback', 'Running Back', 'Receiver', 'Lineman', 'Slam Dunk', 'Posterizer', 'Dribbler', '3Pt Shooter', 'Baseball a Slugger', 'Baseball a Heater', 'Baseball a Catcher', 'Baseball a Runner'];
const BASES = [
  { name: 'Royal Gold', color: '#c69d4e' }, { name: 'Sapphire', color: '#477fc5' },
  { name: 'Emerald', color: '#42966f' }, { name: 'Crimson', color: '#b94e55' },
  { name: 'Amethyst', color: '#8865bd' }, { name: 'Obsidian', color: '#777d8b' },
];
const EPITHETS = ['Golden', 'Rising', 'Iron', 'Velocity', 'Crowned', 'Untamed', 'Starlight', 'Victory'];
function randomFrom(items) { return items[Math.floor(Math.random() * items.length)]; }
function makeToken() {
  const pieceType = randomFrom(PIECES), base = randomFrom(BASES), nonce = Math.floor(1000 + Math.random() * 9000);
  return { pieceType, baseColor: base.color, baseName: base.name, nonce, name: randomFrom(EPITHETS) + ' ' + pieceType + ' · ' + nonce };
}
function money(value) { return '$' + (Number(value) || 0).toFixed(2); }

export default function Recommendations({ dataFolder, paperMode: currentPaperMode = true, kalshiAccount, onActivity, onStartWeek, onNavigate }) {
  const root = dataFolder?.handle;
  const [balance, setBalance] = useState('0');
  const walletConnected = Boolean(kalshiAccount?.connected);
  const availableBalance = walletConnected ? Math.max(0, Number(kalshiAccount.balanceDollars) || 0) : 0;
  const paperMode = currentPaperMode;
  const [token, setToken] = useState(makeToken);
  const [seasons, setSeasons] = useState([]);
  const [pieceProfit, setPieceProfit] = useState({});
  const [splitCounts, setSplitCounts] = useState({});
  const [splitConfirm, setSplitConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  async function loadPieces() {
    if (!root) return;
    const profiles = await listSeasonProfiles(root);
    setSeasons(profiles);
    const profits = {};
    await Promise.all(profiles.map(async (profile) => {
      const rows = await readSeasonTrades(root, profile);
      profits[profile.id] = confirmedWalletReturns(rows);
    }));
    setPieceProfit(profits);
  }
  useEffect(() => { loadPieces().catch((e) => setError(e.message || 'Could not load seasons')); }, [root]);

  function cyclePiece() { setToken(makeToken()); setCreated(null); }

  async function updatePiece(profile, patch) {
    try {
      const updated = await updateSeasonProfile(root, profile.id, patch);
      setSeasons((old) => old.map((item) => item.id === updated.id ? updated : item));
    } catch (e) { setError(e.message || 'Could not update season piece'); }
  }

  async function startNextWeek(profile) { onStartWeek?.(profile); }

  async function confirmSplit(profile) {
    const count = Number(splitCounts[profile.id] || profile.splitCount || 2);
    setBusy(true); setError('');
    try {
      const worth = Math.max(0, Number(pieceProfit[profile.id]) || 0);
      if (worth <= 0) throw new Error('This piece has no remaining value to split.');
      const result = await splitSeasonPiece(root, { ...profile, balance: worth }, count);
      setSeasons((old) => [...old.map((item) => item.id === profile.id ? result.parent : item), ...result.children]);
      setSplitConfirm(null);
      onActivity?.('PIECE_SPLIT', profile.name + ' split into ' + count + ' pieces · ' + money(worth));
    } catch (e) { setError(e.message || 'Could not split season piece'); }
    finally { setBusy(false); }
  }

  async function commitSeason() {
    const amount = Number(balance);
    if (!root) { setError('Connect a data folder first.'); return; }
    if (!paperMode && !walletConnected) { setError('Connect and verify your Kalshi account before creating a live season.'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a season balance greater than zero.'); return; }
    if (walletConnected && amount > availableBalance) { setError('Season balance cannot exceed your Kalshi available balance of ' + money(availableBalance) + '.'); return; }
    setBusy(true); setError('');
    try {
      const profile = await createSeasonProfile(root, {
        balance: amount, quotaValue: amount, paperMode, pieceType: token.pieceType, baseColor: token.baseColor,
        baseName: token.baseName, nonce: token.nonce, name: token.name,
        selectionStrategy: '', gridBand: 'pre-even', riskPreference: 'probability',
        diversityMode: 'allow-overlap', splitCount: 2, piecePrompt: '',
      });
      setSeasons((old) => [...old, profile]);
      setPieceProfit((old) => ({ ...old, [profile.id]: 0 }));
      setCreated(profile);
      setToken(makeToken());
      onActivity?.('SEASON_START', profile.name + ' created');
    } catch (e) { setError(e.message || 'Could not create season'); }
    finally { setBusy(false); }
  }

  return <div className="page-shell season-manager">
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>Season Manager</h1><p>Create, configure, and divide season pieces. Each piece controls its own share of season funds.</p></div></div>
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
          <label htmlFor="season-balance">Starting season balance <small>{walletConnected ? 'Available Kalshi balance: ' + money(availableBalance) : 'No wallet connected · paper allocation'}</small></label>
          <div className="season-balance-input"><span>$</span><input id="season-balance" type="number" min="0" max={walletConnected ? availableBalance : undefined} step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00"/></div>
          <div className="season-mode-card"><span className={paperMode ? 'live-dot' : 'live-dot live'}></span><div><b>{paperMode ? 'Paper season' : 'Live season'}</b><small>Uses the current Paper/Live mode setting from the app header.</small></div></div>
          <div className="season-name-preview"><small>GENERATED SEASON NAME</small><b>{token.name}</b><span>Piece value and default quota: {money(balance)}</span></div>
          <button className="primary-btn season-commit" disabled={!root || (!paperMode && !walletConnected) || busy || (walletConnected && Number(balance) > availableBalance) || Number(balance) <= 0} onClick={commitSeason}><PlusCircle size={16}/>{busy ? 'Creating season…' : paperMode && !walletConnected ? 'Create paper season' : 'Commit season'}</button>
          {created && <div className="season-success">Created {created.name} · Season {created.season}</div>}
        </div>
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Season pieces · {seasons.filter((s) => s.activePlayer !== false).length}</h2><p>Configure each piece's strategy and risk against confirmed returned funds.</p></div></div>
      {seasons.length ? <div className="season-manager-list">{seasons.map((s) => {
        const currentWorth = Math.max(0, Number(pieceProfit[s.id]) || 0);
        const quota = Number(s.quotaValue ?? s.balance) || 0;
        return <div className={`season-manager-row season-manager-piece-entry ${s.activePlayer === false ? 'season-inactive' : ''}`} key={s.id}>
          <div className="season-manager-main">
            <SeasonPieceEntry profile={s} earnings={pieceProfit[s.id] || 0} onUpdate={updatePiece} onStartWeek={startNextWeek} onNavigate={onNavigate}/>
            <div className="piece-quota-controls">
              <label>Piece quota value <input type="number" min="0" step="0.01" value={quota} onChange={(e) => updatePiece(s, { quotaValue: Math.max(0, Number(e.target.value) || 0) })}/></label>
              <label>Split into <select value={splitCounts[s.id] || s.splitCount || 2} onChange={(e) => setSplitCounts((old) => ({ ...old, [s.id]: Number(e.target.value) }))}>{Array.from({ length: 19 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} pieces</option>)}</select></label>
              <button className="secondary-btn" disabled={busy || s.activePlayer === false || currentWorth <= 0 || !!s.splitInto?.length} onClick={() => setSplitConfirm(s.id)}><Scissors size={14}/> Split piece</button>
              {splitConfirm === s.id && <div className="split-confirm"><span>Divide {money(currentWorth)} into {Number(splitCounts[s.id] || s.splitCount || 2)} equal-value pieces?</span><button className="primary-btn" disabled={busy} onClick={() => confirmSplit(s)}>Confirm split</button><button className="secondary-btn" onClick={() => setSplitConfirm(null)}>Cancel</button></div>}
            </div>
            <small>Next scheduled: {s.nextScheduledWeek || 'week1'}</small>
          </div>
        </div>;
      })}</div> : <div className="empty-state"><b>No seasons created yet</b><span>Your committed season tokens will be listed here.</span></div>}
    </section>
  </div>;
}
