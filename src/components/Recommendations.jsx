import React, { useEffect, useState } from 'react';
import { RefreshCw, PlusCircle, WalletCards, Scissors } from 'lucide-react';
import { createSeasonProfile, listSeasonProfiles, updateSeasonProfile, splitSeasonPiece, readSeasonTrades } from '../lib/dataModel';
import SeasonToken from './SeasonToken';

const PIECES = ['Quarterback', 'Running Back', 'Receiver', 'Lineman', 'Slam Dunk', 'Posterizer', 'Dribbler', '3Pt Shooter', 'Baseball a Slugger', 'Baseball a Heater', 'Baseball a Catcher', 'Baseball a Runner'];
const BASES = [
  { name: 'Royal Gold', color: '#c69d4e' }, { name: 'Sapphire', color: '#477fc5' },
  { name: 'Emerald', color: '#42966f' }, { name: 'Crimson', color: '#b94e55' },
  { name: 'Amethyst', color: '#8865bd' }, { name: 'Obsidian', color: '#777d8b' },
];
const EPITHETS = ['Golden', 'Rising', 'Iron', 'Velocity', 'Crowned', 'Untamed', 'Starlight', 'Victory'];
const GRID_BANDS = ['pre-even', 'break-even', '2x', '3x'];
const STRATEGIES = [
  { id: 'standard', label: 'Standard', probability: 92, confidence: 90, payout: 1.2 },
  { id: 'value', label: 'Value', probability: 84, confidence: 84, payout: 1.4 },
  { id: 'highroller', label: 'High Roller', probability: 70, confidence: 70, payout: 1.75 },
  { id: 'baseball-no', label: 'Bet No Strat Baseball', probability: 90, confidence: 85, payout: 1 },
];
function randomFrom(items) { return items[Math.floor(Math.random() * items.length)]; }
function makeToken() {
  const pieceType = randomFrom(PIECES), base = randomFrom(BASES), nonce = Math.floor(1000 + Math.random() * 9000);
  return { pieceType, baseColor: base.color, baseName: base.name, nonce, name: randomFrom(EPITHETS) + ' ' + pieceType + ' · ' + nonce };
}
function money(value) { return '$' + (Number(value) || 0).toFixed(2); }

export default function Recommendations({ dataFolder, paperMode: currentPaperMode = true, kalshiAccount, onActivity, onStartWeek }) {
  const root = dataFolder?.handle;
  const [balance, setBalance] = useState('0');
  const availableBalance = kalshiAccount?.connected ? Math.max(0, Number(kalshiAccount.balanceDollars) || 0) : 0;
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
      profits[profile.id] = rows.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
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
      const worth = Math.max(0, (Number(profile.balance) || 0) + (Number(pieceProfit[profile.id]) || 0));
      if (worth <= 0) throw new Error('This piece has no remaining value to split.');
      const result = await splitSeasonPiece(root, { ...profile, balance: worth }, count);
      setSeasons((old) => [...old.map((item) => item.id === profile.id ? result.parent : item), ...result.children]);
      setSplitConfirm(null);
      onActivity?.('PIECE_SPLIT', profile.name + ' split into ' + count + ' pieces · ' + money(worth));
    } catch (e) { setError(e.message || 'Could not split season piece'); }
    finally { setBusy(false); }
  }

  function strategyOrder(profile, currentWorth, quota) {
    const ratio = quota > 0 ? currentWorth / quota : 0;
    const band = ratio >= 3 ? '3x' : ratio >= 2 ? '2x' : ratio >= 1 ? 'break-even' : 'pre-even';
    const offset = Math.max(0, GRID_BANDS.indexOf(band));
    return { band, ratio, items: [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)] };
  }

  async function commitSeason() {
    const amount = Number(balance);
    if (!root) { setError('Connect a data folder first.'); return; }
    if (!kalshiAccount?.connected) { setError('Connect and verify your Kalshi account before allocating a season balance.'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a season balance greater than zero.'); return; }
    if (amount > availableBalance) { setError('Season balance cannot exceed your Kalshi available balance of ' + money(availableBalance) + '.'); return; }
    setBusy(true); setError('');
    try {
      const profile = await createSeasonProfile(root, {
        balance: amount, quotaValue: amount, paperMode, pieceType: token.pieceType, baseColor: token.baseColor,
        baseName: token.baseName, nonce: token.nonce, name: token.name,
        selectionStrategy: 'standard', gridBand: 'pre-even', riskPreference: 'probability',
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
          <label htmlFor="season-balance">Starting season balance <small>Available Kalshi balance: {money(availableBalance)}</small></label>
          <div className="season-balance-input"><span>$</span><input id="season-balance" type="number" min="0" max={availableBalance} step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00"/></div>
          <div className="season-mode-card"><span className={paperMode ? 'live-dot' : 'live-dot live'}></span><div><b>{paperMode ? 'Paper season' : 'Live season'}</b><small>Uses the current Paper/Live mode setting from the app header.</small></div></div>
          <div className="season-name-preview"><small>GENERATED SEASON NAME</small><b>{token.name}</b><span>Piece value and default quota: {money(balance)}</span></div>
          <button className="primary-btn season-commit" disabled={!root || !kalshiAccount?.connected || busy || Number(balance) > availableBalance || Number(balance) <= 0} onClick={commitSeason}><PlusCircle size={16}/>{busy ? 'Creating season…' : 'Commit season'}</button>
          {created && <div className="season-success">Created {created.name} · Season {created.season}</div>}
        </div>
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Season pieces · {seasons.filter((s) => s.activePlayer !== false).length}</h2><p>Configure the grid, risk, diversity, strategy, and each piece's monetary quota.</p></div></div>
      {seasons.length ? <div className="season-manager-list">{seasons.map((s) => {
        const currentWorth = Math.max(0, (Number(s.balance) || 0) + (Number(pieceProfit[s.id]) || 0));
        const quota = Number(s.quotaValue ?? s.balance) || 0;
        const selected = s.selectionStrategy || 'standard';
        const grid = strategyOrder(s, currentWorth, quota);
        const ordered = grid.items;
        return <article className={`season-manager-row ${s.activePlayer === false ? 'season-inactive' : ''}`} key={s.id}>
          <SeasonToken pieceType={s.pieceType} baseColor={s.baseColor} size={68}/>
          <div className="season-manager-main">
            <b>{s.name}</b><span>Piece worth {money(currentWorth)} · Quota {money(quota)} · Season {s.season}</span>
            <small>{s.pieceType} · {s.baseName} base · {s.status === 'split' ? 'Split parent' : s.activePlayer === false ? 'Inactive' : 'Active'} · {s.paperMode ? 'Paper' : 'Live'}</small>
            {s.parentPieceId && <small>Split from {s.parentPieceId} · child {s.splitIndex}/{s.splitCount}</small>}
            <div className="season-piece-controls">
              <button className="secondary-btn" onClick={() => startNextWeek(s)} disabled={busy || s.activePlayer === false}>Start next week</button>
              <label className={`auto-switch ${s.auto ? 'enabled' : ''}`}><input type="checkbox" checked={!!s.auto} onChange={(e) => updatePiece(s, { auto: e.target.checked })}/><span className="auto-switch-track"></span><b>Auto</b></label>
              <select value={s.strategy || 'midpoint'} onChange={(e) => updatePiece(s, { strategy: e.target.value })} aria-label={s.name + ' ladder population'}><option value="midpoint">Midpoint lines</option><option value="cliff">Cliff lines</option></select>
            </div>
            <div className="piece-strategy-grid">
              <div className="piece-grid-settings">
                <label>Risk · top axis<select value={s.riskPreference || 'probability'} onChange={(e) => updatePiece(s, { riskPreference: e.target.value })}><option value="probability">Probability first · strict</option><option value="balanced">Balanced</option><option value="value">Value first · lenient</option></select></label>
                <label className={'auto-switch ' + (s.safe ? 'enabled' : '')}><input type="checkbox" checked={!!s.safe} onChange={(e) => updatePiece(s, { safe: e.target.checked })}/><span className="auto-switch-track"></span><b>Safe strategy</b></label>
              </div>
              <div className="piece-grid-horizontal">
                {GRID_BANDS.map((band) => <span key={band} className={'piece-grid-band ' + (grid.band === band ? 'active' : '')}>{band === 'pre-even' ? 'Pre-even' : band === 'break-even' ? 'Breaking even' : band}</span>)}
              </div>
              <small>Position: {grid.band} · {grid.ratio.toFixed(2)}× quota</small>
              <div className="piece-grid-settings">
                <label>Diversity · bottom axis<select value={s.diversityMode || 'allow-overlap'} onChange={(e) => updatePiece(s, { diversityMode: e.target.value })}><option value="allow-overlap">Allow same games</option><option value="avoid-overlap">Avoid other pieces' games</option><option value="split">Prefer diversified split</option></select></label>
              </div>
              <div className="piece-strategy-buttons">
                {ordered.map((item) => <button key={item.id} className={`secondary-btn ${selected === item.id ? 'active' : ''}`} onClick={() => updatePiece(s, { selectionStrategy: item.id })}>{item.label}</button>)}
              </div>
              <small>Thresholds: {STRATEGIES.find((x) => x.id === selected)?.probability}% probability · {STRATEGIES.find((x) => x.id === selected)?.confidence}% confidence · {STRATEGIES.find((x) => x.id === selected)?.payout.toFixed(2)}× minimum payout</small>
            </div>
            <div className="piece-quota-controls">
              <label>Piece quota value <input type="number" min="0" step="0.01" value={quota} onChange={(e) => updatePiece(s, { quotaValue: Math.max(0, Number(e.target.value) || 0) })}/></label>
              <label>Split into <select value={splitCounts[s.id] || s.splitCount || 2} onChange={(e) => setSplitCounts((old) => ({ ...old, [s.id]: Number(e.target.value) }))}>{Array.from({ length: 19 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} pieces</option>)}</select></label>
              <button className="secondary-btn" disabled={busy || s.activePlayer === false || currentWorth <= 0 || !!s.splitInto?.length} onClick={() => setSplitConfirm(s.id)}><Scissors size={14}/> Split piece</button>
              {splitConfirm === s.id && <div className="split-confirm"><span>Divide {money(currentWorth)} into {Number(splitCounts[s.id] || s.splitCount || 2)} equal-value pieces?</span><button className="primary-btn" disabled={busy} onClick={() => confirmSplit(s)}>Confirm split</button><button className="secondary-btn" onClick={() => setSplitConfirm(null)}>Cancel</button></div>}
            </div>
            <small>Next scheduled: {s.nextScheduledWeek || 'week1'}</small>
          </div>
        </article>;
      })}</div> : <div className="empty-state"><b>No seasons created yet</b><span>Your committed season tokens will be listed here.</span></div>}
    </section>
  </div>;
}
