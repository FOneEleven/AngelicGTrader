import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity, LayoutDashboard, Radar, BrainCircuit, ClipboardList, Trophy,
  ChartNoAxesCombined, History, Settings, FileText, ChevronRight,
  Search, Bell, CircleHelp, ArrowUpRight, ArrowDownRight, ShieldCheck, ShieldAlert,
  Clock3, Target, Zap, Menu, X, RefreshCw, Filter, ExternalLink
} from 'lucide-react';
import DataFolderConnect from './components/DataFolderConnect';
import LatestActivity from './components/LatestActivity';
import PaperModeToggle from './components/PaperModeToggle';
import Recommendations from './components/Recommendations';
import LiveMarketScanner from './components/LiveMarketScanner';
import AIPredictions from './components/AIPredictions';
import SeasonToken from './components/SeasonToken';
import { readSettings, writeSettings, readTrades, readAllRecords, deleteTrade, listSeasonProfiles } from './lib/dataModel';
import { WEEKS } from './lib/dataFolder';
import { readCache, isCacheFresh, appendCacheBatch } from './lib/marketCache';
import { fetchSportsMarkets } from './lib/kalshi';

const nav = [
  { label: 'Dashboard', icon: LayoutDashboard, group: 'WORKSPACE' },
  { label: 'Live Market Scanner', icon: Radar, group: 'WORKSPACE' },
  { label: 'AI Predictions', icon: BrainCircuit, group: 'WORKSPACE' },
  { label: 'Season Manager', icon: ClipboardList, group: 'WORKSPACE' },
  { label: 'Game Day', icon: Trophy, group: 'WORKSPACE' },
  { label: 'Performance Analytics', icon: ChartNoAxesCombined, group: 'INSIGHTS' },
  { label: 'Prediction History', icon: History, group: 'INSIGHTS' },
  { label: 'Configuration', icon: Settings, group: 'SYSTEM' },
  { label: 'System Logs', icon: FileText, group: 'SYSTEM' },
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

function Dashboard({ dataFolder, activityFilter, onActivityFilter, refreshKey, paperMode, onNavigate, onActivity }) {
  const [records, setRecords] = useState([]);
  const [seasonProfiles, setSeasonProfiles] = useState([]);
  useEffect(() => {
    const root = dataFolder?.handle;
    if (!root) { setRecords([]); return; }
    let cancelled = false;
    (async () => {
      const season = dataFolder?.season || 1;
      const all = await readAllRecords(root);
      const profiles = await listSeasonProfiles(root);
      if (!cancelled) setSeasonProfiles(profiles);
      if (!all.length) {
        const legacy = (await Promise.all(WEEKS.map((week) => readTrades(root, season, week)))).flat();
        legacy.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        all.push(...legacy);
      }
      if (!cancelled) setRecords(all);
    })().catch(() => { if (!cancelled) setRecords([]); });
    return () => { cancelled = true; };
  }, [dataFolder, refreshKey]);

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
        <div className="panel-heading"><div><h2>Records</h2><p>Predictions and recommendations saved using Record</p></div><button className="text-btn" onClick={() => onNavigate?.('AI Predictions')}>AI Predictions <ChevronRight size={15}/></button></div>
        {records.length ? (
          <div className="table-wrap"><table><thead><tr><th>RECORDED</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>MODEL PROB.</th><th>PRICE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>
            {records.map((r) => <tr key={r.id}><td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.matchup}</td><td>{r.market}</td><td>{r.side}</td><td>{r.modelProbability == null ? (r.probability + '%') : Math.round(Number(r.modelProbability) * 100) + '%'}</td><td>{r.price}¢</td><td><span className="status-pill">{r.status || 'open'}</span></td><td><button className="danger-text-btn" onClick={async () => { await deleteTrade(dataFolder.handle, r.id); setRecords((old) => old.filter((item) => item.id !== r.id)); onActivity?.('RECORD_REMOVED', 'Record removed · ' + r.market); }}>Remove</button></td></tr>)}
          </tbody></table></div>
        ) : <div className="empty-state"><div className="empty-icon"><ClipboardList size={22}/></div><b>No records yet</b><span>Use Record in AI Predictions to add an entry here.</span></div>}
        <div className="table-foot"><span>Saved locally in your season/week records</span><span>{records.length} records</span></div>
      </section>
      <section className="panel side-panel">
        <div className="panel-heading"><div><h2>System checks</h2><p>Integration status</p></div><span className="check-ring"><ShieldCheck size={17}/></span></div>
        {[
          ['Dashboard','Running locally','ok'],
          ['Market API','Connected · cached','ok'],
          ['Sports data','Not connected','wait'],
          ['TXT history','Ready for local files','ok'],
          [paperMode ? 'Paper trader' : 'Live trader','Awaiting data feeds','wait'],
        ].map(([name, status, state]) => <div className="check-row" key={name}><span className={`check-dot ${state}`}></span><div><b>{name}</b><small>{status}</small></div></div>)}
        <div className="side-tip"><Zap size={16}/><span>Next: connect market discovery and sports data, then start recording timestamped paper predictions.</span></div>
      </section>
    </div>
    <section className="season-pieces-section">
      <div className="season-pieces-heading"><div><h2>Season pieces</h2><p>Each committed token represents an individual season.</p></div><span>{seasonProfiles.length} active</span></div>
      {seasonProfiles.length ? <div className="season-pieces-grid">{seasonProfiles.map((season) => <article className="season-piece-card" key={season.id}>
        <div className="season-piece-art"><SeasonToken pieceType={season.pieceType} baseColor={season.baseColor} size={104}/></div>
        <div className="season-piece-info"><b>{season.name}</b><span>Season {season.season} · {season.paperMode ? 'Paper' : 'Live'}</span><strong>$ {Number(season.balance).toFixed(2)}</strong><small>{season.pieceType} · {season.baseName} base</small></div>
      </article>)}</div> : <div className="season-pieces-empty">No season pieces yet. Create your first one in Season Manager.</div>}
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

  const groups = ['WORKSPACE', 'INSIGHTS', 'SYSTEM'];
  const filtered = nav.filter(n => n.label.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    if (!dataFolder?.handle) return;
    readSettings(dataFolder.handle).then((s) => setPaperMode(!!s.paperMode)).catch(() => {});
  }, [dataFolder]);

  const handlePaperToggle = useCallback(async (next) => {
    setPaperMode(next);
    if (dataFolder?.handle) {
      try { await writeSettings(dataFolder.handle, { paperMode: next }); } catch {}
    }
  }, [dataFolder]);

  const handleActivity = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={21}/></div><div className="brand-text"><b>AngelicGTrader</b><small>SPORTS INTELLIGENCE</small></div><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <div className="sidebar-search"><Search size={15}/><input placeholder="Find a section..." value={search} onChange={e => setSearch(e.target.value)}/><kbd>/</kbd></div>
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
          <PaperModeToggle enabled={paperMode} onChange={handlePaperToggle} disabled={!dataFolder?.handle} />
          <span className="connection"><i></i> Local app</span>
          <button className="icon-btn" title="Help"><CircleHelp size={17}/></button>
          <button className="icon-btn" title="Notifications"><Bell size={17}/></button>
        </div>
      </header>
      <div className="page-content">
        {active === 'Dashboard' && (
          <>
            <DataFolderConnect onFolderReady={setDataFolder} />
            <Dashboard dataFolder={dataFolder} activityFilter={activityFilter} onActivityFilter={setActivityFilter} refreshKey={refreshKey} paperMode={paperMode} onNavigate={setActive} onActivity={handleActivity} />
          </>
        )}
        {active === 'Live Market Scanner' && (
          <LiveMarketScanner dataFolder={dataFolder} onActivity={handleActivity} onNavigate={setActive} />
        )}
        {active === 'AI Predictions' && (
          <AIPredictions dataFolder={dataFolder} onActivity={handleActivity} />
        )}
        {active === 'Season Manager' && (
          <Recommendations dataFolder={dataFolder} paperMode={paperMode} onActivity={handleActivity} />
        )}
        {active !== 'Dashboard'
          && active !== 'Live Market Scanner'
          && active !== 'AI Predictions'
          && active !== 'Season Manager'
          && <Placeholder page={active} />}
      </div>
      <footer>
        <span>AngelicGTrader · Local development build</span>
        <span className={paperMode ? '' : 'live'}>{paperMode ? 'Paper mode' : 'Live mode'} <i className={`footer-dot ${paperMode ? '' : 'live'}`}></i></span>
      </footer>
    </main>
  </div>;
}