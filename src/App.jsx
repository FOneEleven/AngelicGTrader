import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity, LayoutDashboard, Radar, BrainCircuit, ClipboardList, Trophy,
  ChartNoAxesCombined, History, Settings, FileText, ChevronRight,
  Search, Bell, CircleHelp, ArrowUpRight, ArrowDownRight, ShieldCheck, ShieldAlert,
  Clock3, Target, Menu, X, RefreshCw, Filter, ExternalLink
} from 'lucide-react';
import DataFolderConnect from './components/DataFolderConnect';
import LatestActivity from './components/LatestActivity';
import PaperModeToggle from './components/PaperModeToggle';
import Recommendations from './components/Recommendations';
import LiveMarketScanner from './components/LiveMarketScanner';
import AIPredictions from './components/AIPredictions';
import GameDay from './components/GameDay';
import PredictionHistory from './components/PredictionHistory';
import SeasonPieceEntry from './components/SeasonPieceEntry';
import { readSettings, writeSettings, readDashboardRecords, deleteTrade, listSeasonProfiles, updateSeasonProfile, advanceSeasonWeek, readSeasonTrades, appendTrade, clearDashboardRecords } from './lib/dataModel';
import { readCache, isCacheFresh, appendCacheBatch } from './lib/marketCache';
import { fetchSportsMarkets } from './lib/kalshi';

const nav = [
  { label: 'Dashboard', icon: LayoutDashboard, group: 'WORKSPACE' },
  { label: 'Live Market Scanner', icon: Radar, group: 'WORKSPACE' },
  { label: 'AI Predictions', icon: BrainCircuit, group: 'WORKSPACE' },
  { label: 'Season Manager', icon: ClipboardList, group: 'WORKSPACE' },
  { label: 'Game Day', icon: Trophy, group: 'WORKSPACE' },
  { label: 'Prediction History', icon: History, group: 'WORKSPACE' },
];

const opportunities = [
  { sport: 'NFL', league: 'American Football', matchup: 'Buffalo Bills vs. New York Jets', market: 'Bills team points · 17+', probability: 88.4, price: '82¢', status: 'Qualifying review', time: 'Today · 8:15 PM ET', color: 'blue' },
  { sport: 'NBA', league: 'Basketball', matchup: 'Boston Celtics vs. Miami Heat', market: 'Celtics team points · 100+', probability: 86.1, price: '80¢', status: 'Stakes check pending', time: 'Today · 7:30 PM ET', color: 'green' },
  { sport: 'NHL', league: 'Ice Hockey', matchup: 'Edmonton Oilers vs. Calgary Flames', market: 'Oilers team goals · 2+', probability: 84.7, price: '79¢', status: 'Awaiting lineup data', time: 'Tomorrow · 9:00 PM ET', color: 'orange' },
];

function StatCard({ title, value, note, icon: Icon, tone = 'gold', trend }) {
  return <div className="stat-card">
    <div className="stat-top"><span>{title}</span><span className={`stat-icon ${tone}`}><Icon size={17}/></span></div>
    <div className="stat-value">{value}</div>
    <div className="stat-note">{trend && <span className={trend === 'up' ? 'positive' : 'muted'}>{trend === 'up' ? <ArrowUpRight size={14}/> : <ArrowDownRight size={14}/>}</span>}{note}</div>
  </div>;
}

function Dashboard({ dataFolder, activityFilter, onActivityFilter, refreshKey, paperMode, onNavigate, onActivity, onStartWeek }) {
  const [records, setRecords] = useState([]);
  const [seasonProfiles, setSeasonProfiles] = useState([]);
  const [pieceEarnings, setPieceEarnings] = useState({});
  const [pieceCommitments, setPieceCommitments] = useState({});
  const [selectedPieceByRecord, setSelectedPieceByRecord] = useState({});
  const [placingRecordId, setPlacingRecordId] = useState('');
  const [recordActionMessage, setRecordActionMessage] = useState({});
  const [placedRecordIds, setPlacedRecordIds] = useState([]);
  useEffect(() => {
    const root = dataFolder?.handle;
    if (!root) { setRecords([]); setSeasonProfiles([]); setPlacedRecordIds([]); setPieceCommitments({}); return; }
    let cancelled = false;
    (async () => {
      const all = await readDashboardRecords(root);
      const profiles = await listSeasonProfiles(root);
      const pieceEntries = await Promise.all(profiles.map(async (profile) => {
        const trades = await readSeasonTrades(root, profile);
        const currentWeek = profile.nextScheduledWeek || 'week1';
        const committed = trades.some((trade) => trade.week === currentWeek && /^(open|pending|placed)$/i.test(String(trade.status || '')));
        return { id: profile.id, earnings: trades.reduce((sum, trade) => sum + (Number(trade.earnings ?? trade.profit) || 0), 0), committed };
      }));
      if (!cancelled) {
        setSeasonProfiles(profiles);
        setPieceEarnings(Object.fromEntries(pieceEntries.map((entry) => [entry.id, entry.earnings])));
        setPieceCommitments(Object.fromEntries(pieceEntries.map((entry) => [entry.id, entry.committed])));
      }
      if (!cancelled) {
        setPlacedRecordIds(all.filter((item) => item.sourceRecordId).map((item) => item.sourceRecordId));
        setRecords(all.filter((item) => item.source !== 'dashboard-record' && !(item.isQualifiedCandidate && String(item.finalVerdict || '').toUpperCase() === 'REJECT')));
      }
    })().catch(() => { if (!cancelled) setRecords([]); });
    return () => { cancelled = true; };
  }, [dataFolder, refreshKey]);

  async function updateDashboardPiece(profile, patch) {
    try {
      const updated = await updateSeasonProfile(dataFolder.handle, profile.id, patch);
      setSeasonProfiles((old) => old.map((item) => item.id === updated.id ? updated : item));
      onActivity?.('SEASON_UPDATE', updated.name + ' updated');
    } catch (e) { console.error(e); }
  }
  async function startDashboardWeek(profile) { onStartWeek?.(profile); }
  async function placeDashboardRecord(record) {
    const profile = seasonProfiles.find((item) => item.id === selectedPieceByRecord[record.id]);
    if (!profile) { setRecordActionMessage((old) => ({ ...old, [record.id]: 'Select a season piece first.' })); return; }
    if (profile.paperMode !== true) { setRecordActionMessage((old) => ({ ...old, [record.id]: 'Live order placement is not implemented yet. No order was sent.' })); return; }
    if (profile.activePlayer === false || String(profile.status || 'active').toLowerCase() !== 'active') {
      setRecordActionMessage((old) => ({ ...old, [record.id]: 'This season piece is inactive.' })); return;
    }
    const allocation = Number(profile.quotaValue ?? profile.initialBalance ?? profile.balance);
    const price = Number(record.price);
    if (!(allocation > 0) || !(price > 0 && price < 100) || !record.ticker) {
      setRecordActionMessage((old) => ({ ...old, [record.id]: 'Missing valid allocation, saved price, or market ticker.' })); return;
    }
    setPlacingRecordId(record.id);
    setRecordActionMessage((old) => ({ ...old, [record.id]: '' }));
    try {
      const week = profile.nextScheduledWeek || 'week1';
      const existingTrades = await readSeasonTrades(dataFolder.handle, profile);
      if (existingTrades.some((trade) => trade.week === week && /^(open|pending|placed)$/i.test(String(trade.status || '')))) {
        setPieceCommitments((old) => ({ ...old, [profile.id]: true }));
        throw new Error('This piece is already committed to a game this week.');
      }
      if (existingTrades.some((trade) => trade.sourceRecordId === record.id)) throw new Error('This record has already been placed with this piece.');
      const trade = {
        id: 'record-bet-' + (globalThis.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(16).slice(2))),
        timestamp: new Date().toISOString(), matchup: record.matchup || '', market: record.market || '',
        side: record.side || '', price, probability: Number(record.probability ?? record.modelProbability) || 0,
        stake: Math.round(allocation * 100) / 100, paper: true, status: 'open',
        ticker: record.ticker, line: record.line ?? null, marketProbability: record.marketProbability ?? null,
        modelProbability: record.modelProbability ?? record.probability ?? null, edge: record.edge ?? null,
        seasonPieceId: profile.id, week, sourceRecordId: record.id, payoutMultiple: 100 / price,
        source: 'dashboard-record',
      };
      await appendTrade(dataFolder.handle, profile.season, week, trade);
      setPlacedRecordIds((old) => old.includes(record.id) ? old : [...old, record.id]);
      setRecords((old) => old.map((item) => item.id === record.id ? { ...item, placedPieceId: profile.id, placedTradeId: trade.id } : item));
      setPieceCommitments((old) => ({ ...old, [profile.id]: true }));
      setRecordActionMessage((old) => ({ ...old, [record.id]: 'Paper bet placed · ' + profile.name }));
      onActivity?.('PAPER_TRADE', 'Dashboard record placed · ' + (record.market || record.matchup) + ' · ' + profile.name);
    } catch (error) {
      setRecordActionMessage((old) => ({ ...old, [record.id]: error.message || 'Could not place this record.' }));
    } finally { setPlacingRecordId(''); }
  }

  // Warm the local market cache when Dashboard opens; the scanner viewer stays collapsed.
  useEffect(() => {
    const root = dataFolder?.handle;
    if (!root) return;
    let cancelled = false;
    (async () => {
      const fresh = await isCacheFresh(root);
      if (fresh) return;
      const markets = await fetchSportsMarkets();
      if (!cancelled && markets.length) await appendCacheBatch(root, markets);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [dataFolder]);
  return <>
    <div className="page-heading">
      <div><div className="eyebrow">OVERVIEW</div><h1>Dashboard</h1><p>Your sports-market intelligence at a glance.</p></div>
      <button className="secondary-btn"><RefreshCw size={15}/> Refresh data</button>
    </div>
    {paperMode ? (
      <div className="notice"><div className="notice-icon"><ShieldCheck size={19}/></div><div><b>Paper mode is active</b><span>All predictions are simulated. No real-money orders are being placed.</span></div><span className="live-dot"></span></div>
    ) : (
      <div className="notice notice-live"><div className="notice-icon live"><ShieldAlert size={19}/></div><div><b>Live mode is active</b><span>Recommendations are treated as real trades. Paper mode is off.</span></div><span className="live-dot live"></span></div>
    )}
    <div className="stats-grid">
      <StatCard title="Markets discovered" value="—" note="Waiting for market data connection" icon={Radar}/>
      <StatCard title="Paper predictions" value="0" note="No predictions recorded yet" icon={BrainCircuit} tone="purple"/>
      <StatCard title="Verified win rate" value="—" note="Requires resolved predictions" icon={Target} tone="green"/>
      <StatCard title="Simulated P/L" value="$0.00" note="No simulated trades yet" icon={ChartNoAxesCombined} tone="blue"/>
    </div>
    <div className="content-grid">
      <section className="panel opportunities-panel">
        <div className="panel-heading"><div><h2>Records</h2><p>Scanner-qualified candidates with final matchup reviews and recorded predictions</p></div><button className="text-btn" onClick={() => onNavigate?.('AI Predictions')}>AI Predictions <ChevronRight size={15}/></button></div>
        {records.length ? (
          <div className="table-wrap"><table><thead><tr><th>RECORDED</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>MODEL PROB.</th><th>PRICE</th><th>PAYOUT</th><th>STATUS</th><th>PLACE BET</th><th>ACTION</th></tr></thead><tbody>
            {records.map((r) => {
              const price = Number(r.price);
              const payout = price > 0 ? (100 / price).toFixed(2) + 'x' : '—';
              const eligiblePieces = seasonProfiles.filter((p) => p.activePlayer !== false && String(p.status || 'active').toLowerCase() === 'active' && Number(p.quotaValue ?? p.initialBalance ?? p.balance) > 0 && pieceCommitments[p.id] !== true);
              const selectedId = selectedPieceByRecord[r.id] || '';
              const selectedPiece = eligiblePieces.find((p) => p.id === selectedId);
              const committed = selectedPiece ? pieceCommitments[selectedPiece.id] === true : false;
              const alreadyPlaced = !!r.placedTradeId || placedRecordIds.includes(r.id) || (!!r.seasonPieceId && !r.isQualifiedCandidate);
              const canPlacePaper = selectedPiece?.paperMode === true && !committed && !alreadyPlaced && !!r.ticker && price > 0 && price < 100;
              return <tr key={r.id}>
                <td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.matchup}</td><td>{r.market}</td><td>{r.side}</td>
                <td>{r.modelProbability == null ? (r.probability + '%') : Math.round(Number(r.modelProbability) * 100) + '%'}</td>
                <td>{r.price}¢</td><td>{payout}</td><td><span className="status-pill">{r.status || 'open'}</span></td>
                <td><div className="record-place-control">
                  <select value={selectedId} onChange={(event) => setSelectedPieceByRecord((old) => ({ ...old, [r.id]: event.target.value }))}>
                    <option value="">Select piece</option>
                    {eligiblePieces.map((p) => <option key={p.id} value={p.id}>{p.name + ' · ' + (p.paperMode ? 'Paper' : 'Live') + ' · ' + String.fromCharCode(36) + Number(p.quotaValue ?? p.initialBalance ?? p.balance).toFixed(2) + (pieceCommitments[p.id] ? ' · Committed' : '')}</option>)}
                  </select>
                  <button className="secondary-btn" disabled={!selectedPiece || placingRecordId === r.id || alreadyPlaced || (selectedPiece.paperMode && !canPlacePaper) || !selectedPiece.paperMode} onClick={() => placeDashboardRecord(r)}>{placingRecordId === r.id ? 'Placing…' : selectedPiece?.paperMode ? 'Place bet' : 'Live unavailable'}</button>
                  {recordActionMessage[r.id] && <small className="record-action-message">{recordActionMessage[r.id]}</small>}
                  {committed && <small className="record-action-message">Piece already committed this week.</small>}
                  {alreadyPlaced && <small className="record-action-message">Already placed.</small>}
                </div></td>
                <td><button className="danger-text-btn" onClick={async () => { await deleteTrade(dataFolder.handle, r.id); setRecords((old) => old.filter((item) => item.id !== r.id)); onActivity?.('RECORD_REMOVED', 'Record removed · ' + r.market); }}>Remove</button></td>
              </tr>;
            })}
          </tbody></table></div>
        ) : <div className="empty-state"><div className="empty-icon"><ClipboardList size={22}/></div><b>No records yet</b><span>Use Record in AI Predictions to add an entry here.</span></div>}
        <div className="table-foot"><span>Saved locally in your season/week records</span><span>{records.length} records</span></div>
      </section>
    </div>
    <section className="season-pieces-section">
      <div className="season-pieces-heading"><div><h2>Season pieces</h2><p>Shared season-piece entries. Open a piece to edit its strategy and message it.</p></div><span>{seasonProfiles.filter((item) => item.activePlayer !== false).length} active</span></div>
      {seasonProfiles.length ? <div className="season-pieces-grid">{seasonProfiles.map((profile) => <SeasonPieceEntry
        key={profile.id}
        profile={profile}
        earnings={pieceEarnings[profile.id] || 0}
        onUpdate={updateDashboardPiece}
        onStartWeek={startDashboardWeek}
        onNavigate={onNavigate}
      />)}</div> : <div className="season-pieces-empty">No season pieces yet. Create your first one in Season Manager.</div>}
    </section>
    <LatestActivity dataFolder={dataFolder} filter={activityFilter} onFilterChange={onActivityFilter} key={refreshKey} />
  </>;
}

function Placeholder({ page }) {
  const item = nav.find(n => n.label === page);
  const Icon = item?.icon || Activity;
  const descriptions = {
    'Game Day': 'Track season-piece earnings, active players, scheduled games and weekly starts.',
    'Performance Analytics': 'Measure prediction accuracy, simulated returns and performance by sport.',
    'Prediction History': 'Inspect the append-only TXT prediction and results history.',
    'Configuration': 'Configure probability thresholds, payout targets, data sources and risk limits.',
    'System Logs': 'Review scanner runs, data-feed health and prediction-engine events.'
  };
  return <div className="placeholder panel"><div className="placeholder-icon"><Icon size={25}/></div><div className="eyebrow">WORKSPACE MODULE</div><h1>{page}</h1><p>{descriptions[page]}</p><div className="coming">Module shell ready · integration pending</div></div>;
}

export default function App() {
  const [active, setActive] = useState('Dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dataFolder, setDataFolder] = useState(null);
  const [paperMode, setPaperMode] = useState(true);
  const [activityFilter, setActivityFilter] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [kalshiAccount, setKalshiAccount] = useState(null);
  const [scanRequest, setScanRequest] = useState(null);

  const groups = ['WORKSPACE'];
  const filtered = nav;

  useEffect(() => {
    if (!dataFolder?.handle) return;
    readSettings(dataFolder.handle).then(async (s) => {
      const nextMode = kalshiAccount?.connected ? !!s.paperMode : true;
      setPaperMode(nextMode);
      if (!kalshiAccount?.connected && !s.paperMode) await writeSettings(dataFolder.handle, { paperMode: true });
    }).catch(() => {});
  }, [dataFolder, kalshiAccount]);

  const handlePaperToggle = useCallback(async (next) => {
    if (!kalshiAccount?.connected && next === false) return;
    setPaperMode(next);
    if (dataFolder?.handle) {
      try { await writeSettings(dataFolder.handle, { paperMode: next }); } catch {}
    }
  }, [dataFolder, kalshiAccount]);

  const handleActivity = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleStartWeek = useCallback(async (profile) => {
    if (!dataFolder?.handle || !profile) return;
    try {
      // Reset Dashboard records before advancing the piece or starting its scan.
      await clearDashboardRecords(dataFolder.handle);
      const updated = await advanceSeasonWeek(dataFolder.handle, profile);
      setScanRequest({ profileId: updated.id, requestId: updated.id + '-' + Date.now() });
      setActive('AI Predictions');
      handleActivity();
    } catch (e) {
      console.error(e);
    }
  }, [dataFolder, handleActivity]);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={21}/></div><div className="brand-text"><b>AngelicGTrader</b><small>SPORTS INTELLIGENCE</small></div><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <nav>{groups.map(group => {
        const items = filtered.filter(n => n.group === group);
        return items.length ? <div className="nav-group" key={group}><div className="nav-label">{group}</div>{items.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${active === item.label ? 'active' : ''}`} onClick={() => {setActive(item.label);setSidebarOpen(false);}}><Icon size={17}/><span>{item.label}</span>{active === item.label && <span className="active-bar"/>}</button>; })}</div> : null;
      })}</nav>
      <div className="sidebar-bottom">
        <div className={`mode-card ${paperMode ? '' : 'live'}`}>
          <div className="mode-head">
            <span className={`live-dot ${paperMode ? '' : 'live'}`}></span>
            <b>{paperMode ? 'Paper trading mode' : 'Live trading mode'}</b>
          </div>
          <p>{paperMode ? 'Simulation only. Real orders disabled.' : 'Live recommendations. Real orders enabled.'}</p>
        </div>
        <div className="user-row"><div className="avatar">A</div><div><b>Local workspace</b><small>Development environment</small></div><Settings size={16}/></div>
      </div>
    </aside>
    {sidebarOpen && <div className="mobile-overlay" onClick={() => setSidebarOpen(false)}></div>}
    <main className="main">
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setSidebarOpen(true)}><Menu size={19}/></button>
        <div className="breadcrumb">Workspace <ChevronRight size={14}/><b>{active}</b></div>
        <div className="top-actions">
          {kalshiAccount && <div className="header-kalshi-account"><b>{kalshiAccount.accountName}</b><span>${Number(kalshiAccount.balanceDollars || 0).toFixed(2)}</span></div>}
          <PaperModeToggle enabled={paperMode} onChange={handlePaperToggle} disabled={!dataFolder?.handle || !kalshiAccount?.connected} />
          <a className="header-doc-btn" title="Documentation" href="https://github.com/FOneEleven/AngelicGTrader/blob/main/README.md" target="_blank" rel="noreferrer"><FileText size={16}/><span>Docs</span></a>
          <button className="icon-btn" title="Notifications"><Bell size={17}/></button>
        </div>
      </header>
      <div className="page-content">
        {active === 'Dashboard' && (
          <>
            <DataFolderConnect onFolderReady={setDataFolder} onAccountChange={(account) => { setKalshiAccount(account); if (!account?.connected) handlePaperToggle(true); }} />
            <Dashboard dataFolder={dataFolder} activityFilter={activityFilter} onActivityFilter={setActivityFilter} refreshKey={refreshKey} paperMode={paperMode} onNavigate={setActive} onActivity={handleActivity} onStartWeek={handleStartWeek} />
          </>
        )}
        {active === 'Live Market Scanner' && (
          <LiveMarketScanner dataFolder={dataFolder} onActivity={handleActivity} onNavigate={setActive} />
        )}
        {active === 'AI Predictions' && (
          <AIPredictions dataFolder={dataFolder} onActivity={handleActivity} scanRequest={scanRequest} />
        )}
        {active === 'Prediction History' && (
          <PredictionHistory dataFolder={dataFolder} refreshKey={refreshKey} />
        )}
        {active === 'Game Day' && (
          <GameDay dataFolder={dataFolder} onActivity={handleActivity} onStartWeek={handleStartWeek} onNavigate={setActive} />
        )}
        {active === 'Season Manager' && (
          <Recommendations dataFolder={dataFolder} paperMode={paperMode} kalshiAccount={kalshiAccount} onActivity={handleActivity} onStartWeek={handleStartWeek} onNavigate={setActive} />
        )}
        {active !== 'Dashboard'
          && active !== 'Live Market Scanner'
          && active !== 'AI Predictions'
          && active !== 'Season Manager'
          && active !== 'Game Day'
          && active !== 'Prediction History'
          && <Placeholder page={active} />}
      </div>
      <footer>
        <span>AngelicGTrader · Local development build</span>
        <span className={paperMode ? '' : 'live'}>{paperMode ? 'Paper mode' : 'Live mode'} <i className={`footer-dot ${paperMode ? '' : 'live'}`}></i></span>
      </footer>
    </main>
  </div>;
}
