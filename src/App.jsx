import React, { useState } from 'react';
import {
  Activity, LayoutDashboard, Radar, BrainCircuit, ClipboardList, Trophy,
  ChartNoAxesCombined, History, Settings, FileText, ChevronRight,
  Search, Bell, CircleHelp, ArrowUpRight, ArrowDownRight, ShieldCheck,
  Clock3, Target, Zap, Menu, X, RefreshCw, Filter, ExternalLink
} from 'lucide-react';

const nav = [
  { label: 'Dashboard', icon: LayoutDashboard, group: 'WORKSPACE' },
  { label: 'Live Market Scanner', icon: Radar, group: 'WORKSPACE' },
  { label: 'AI Predictions', icon: BrainCircuit, group: 'WORKSPACE' },
  { label: 'Betting Recommendations', icon: ClipboardList, group: 'WORKSPACE' },
  { label: 'Competition Stakes', icon: Trophy, group: 'WORKSPACE' },
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

function Dashboard() {
  return <>
    <div className="page-heading">
      <div><div className="eyebrow">OVERVIEW</div><h1>Dashboard</h1><p>Your sports-market intelligence at a glance.</p></div>
      <button className="secondary-btn"><RefreshCw size={15}/> Refresh data</button>
    </div>
    <div className="notice"><div className="notice-icon"><ShieldCheck size={19}/></div><div><b>Paper mode is active</b><span>All predictions are simulated. No real-money orders are being placed.</span></div><span className="live-dot"></span></div>
    <div className="stats-grid">
      <StatCard title="Markets discovered" value="—" note="Waiting for Kalshi connection" icon={Radar}/>
      <StatCard title="Paper predictions" value="0" note="No predictions recorded yet" icon={BrainCircuit} tone="purple"/>
      <StatCard title="Verified win rate" value="—" note="Requires resolved predictions" icon={Target} tone="green"/>
      <StatCard title="Simulated P/L" value="$0.00" note="No simulated trades yet" icon={ChartNoAxesCombined} tone="blue"/>
    </div>
    <div className="content-grid">
      <section className="panel opportunities-panel">
        <div className="panel-heading"><div><h2>Opportunity pipeline</h2><p>Illustrative layout · not live market data</p></div><button className="text-btn">View scanner <ChevronRight size={15}/></button></div>
        <div className="table-wrap"><table><thead><tr><th>SPORT / MATCHUP</th><th>TEAM SCORING MARKET</th><th>MODEL PROB.</th><th>PRICE</th><th>STATUS</th></tr></thead><tbody>
          {opportunities.map((o) => <tr key={o.matchup}><td><div className="match-sport"><span className={`sport-badge ${o.color}`}>{o.sport}</span><div><b>{o.matchup}</b><small>{o.league} · {o.time}</small></div></div></td><td>{o.market}</td><td><b className="prob">{o.probability}%</b></td><td>{o.price}</td><td><span className="status-pill">{o.status}</span></td></tr>)}
        </tbody></table></div>
        <div className="table-foot"><span>Sample rows demonstrate the interface only.</span><span>Live discovery not connected</span></div>
      </section>
      <section className="panel side-panel">
        <div className="panel-heading"><div><h2>System checks</h2><p>Integration status</p></div><span className="check-ring"><ShieldCheck size={17}/></span></div>
        {[
          ['Dashboard','Running locally','ok'],
          ['Kalshi API','Not connected','wait'],
          ['Sports data','Not connected','wait'],
          ['TXT history','Ready for local files','ok'],
          ['Paper trader','Awaiting data feeds','wait'],
        ].map(([name, status, state]) => <div className="check-row" key={name}><span className={`check-dot ${state}`}></span><div><b>{name}</b><small>{status}</small></div></div>)}
        <div className="side-tip"><Zap size={16}/><span>Next: connect market discovery and sports data, then start recording timestamped paper predictions.</span></div>
      </section>
    </div>
    <section className="panel bottom-panel">
      <div className="panel-heading"><div><h2>Latest activity</h2><p>Prediction and system event log</p></div><button className="icon-btn"><Filter size={16}/></button></div>
      <div className="empty-state"><div className="empty-icon"><Clock3 size={22}/></div><b>No activity recorded</b><span>Once data feeds are connected, predictions and system events will appear here.</span></div>
    </section>
  </>;
}

function Placeholder({ page }) {
  const item = nav.find(n => n.label === page);
  const Icon = item?.icon || Activity;
  const descriptions = {
    'Live Market Scanner': 'Discover available Kalshi sports markets and team scoring thresholds.',
    'AI Predictions': 'Review paper predictions, probabilities, model reasoning and resolved outcomes.',
    'Betting Recommendations': 'Review qualified recommendations with market links for manual execution.',
    'Competition Stakes': 'Filter for games where teams have meaningful playoff or tournament incentives.',
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
  const groups = ['WORKSPACE', 'INSIGHTS', 'SYSTEM'];
  const filtered = nav.filter(n => n.label.toLowerCase().includes(search.toLowerCase()));
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={21}/></div><div><b>KALSHI<span>AI</span></b><small>SPORTS INTELLIGENCE</small></div><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <div className="sidebar-search"><Search size={15}/><input placeholder="Find a section..." value={search} onChange={e => setSearch(e.target.value)}/><kbd>/</kbd></div>
      <nav>{groups.map(group => {
        const items = filtered.filter(n => n.group === group);
        return items.length ? <div className="nav-group" key={group}><div className="nav-label">{group}</div>{items.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${active === item.label ? 'active' : ''}`} onClick={() => {setActive(item.label);setSidebarOpen(false);}}><Icon size={17}/><span>{item.label}</span>{active === item.label && <span className="active-bar"/>}</button>; })}</div> : null;
      })}</nav>
      <div className="sidebar-bottom"><div className="mode-card"><div className="mode-head"><span className="live-dot"></span><b>Paper trading mode</b></div><p>Simulation only. Real orders disabled.</p></div><div className="user-row"><div className="avatar">K</div><div><b>Local workspace</b><small>Development environment</small></div><Settings size={16}/></div></div>
    </aside>
    {sidebarOpen && <div className="mobile-overlay" onClick={() => setSidebarOpen(false)}></div>}
    <main className="main">
      <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)}><Menu size={19}/></button><div className="breadcrumb">Workspace <ChevronRight size={14}/><b>{active}</b></div><div className="top-actions"><span className="connection"><i></i> Local app</span><button className="icon-btn" title="Help"><CircleHelp size={17}/></button><button className="icon-btn" title="Notifications"><Bell size={17}/></button></div></header>
      <div className="page-content">{active === 'Dashboard' ? <Dashboard/> : <Placeholder page={active}/>}</div>
      <footer><span>Kalshi AI · Local development build</span><span>Paper mode <i className="footer-dot"></i></span></footer>
    </main>
  </div>;
}