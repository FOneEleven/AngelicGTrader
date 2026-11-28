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
import { readSettings, writeSettings, readDashboardRecords, deleteTrade, listSeasonProfiles, updateSeasonProfile, advanceSeasonWeek, readSeasonTrades, appendTrade, clearDashboardRecords, readPlayBox, writePlayBox, updateTradeRecord, archiveInactivePiece, confirmedWalletReturns } from './lib/dataModel';
import { readCache, isCacheFresh, appendCacheBatch } from './lib/marketCache';
import { fetchSportsMarkets, submitKalshiOrders, fetchGameScoreResolutions, fetchMarketResolutions, fetchKalshiOrderStatuses } from './lib/kalshi';

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

function Dashboard({ dataFolder, activityFilter, onActivityFilter, refreshKey, paperMode, onNavigate, onActivity, onStartWeek, playBox = [], onAddToPlayBox, onRemoveFromPlayBox, onCommitPlayBox, committingPlayBox, kalshiConnected = false }) {
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
        // A verified losing resolution is authoritative: retire the piece even if
        // an older/stale profile snapshot still says active.
        const losingResolution = trades.find((trade) =>
          String(trade.resolutionStatus || '').toLowerCase() === 'resolved' &&
          (String(trade.outcome || '').toLowerCase() === 'lost' || String(trade.status || '').toLowerCase() === 'lost')
        );
        if (losingResolution && profile.activePlayer !== false) {
          const reason = losingResolution.scoreComparison
            ? losingResolution.scoreComparison + ' · actual score ' + (losingResolution.scoreTeam || 'team') + ' ' + (losingResolution.scoreTeamPoints ?? '—') + ' vs ' + (losingResolution.scoreOpponent || 'opponent') + ' ' + (losingResolution.scoreOpponentPoints ?? '—') + '; selected ' + String(losingResolution.side || '').toUpperCase() + ' did not win.'
            : 'The selected contract resolved as a loss.';
          profile = await updateSeasonProfile(root, profile.id, {
            activePlayer: false, status: 'inactive', selectedLines: [],
            currentWorth: confirmedWalletReturns(trades),
            inactiveSince: losingResolution.resolvedAt || new Date().toISOString(),
            inactiveReason: reason,
          });
          await archiveInactivePiece(root, profile, trades, reason);
        }
        const currentWeek = profile.nextScheduledWeek || 'week1';
        const placedTrade = trades.find((trade) => trade.week === currentWeek && trade.sourceRecordId);
        let savedProfile = profile;
        // Repair older Dashboard placements that created the trade but did not
        // also persist the selected game on the shared season-piece profile.
        if (placedTrade && (profile.selectedLines?.[0]?.ticker !== placedTrade.ticker || profile.selectedLines?.[0]?.sourceRecordId !== placedTrade.sourceRecordId)) {
          const selectedTeam = String(placedTrade.market || '').replace(/\s+over\s+.*$/i, '').trim();
          const selectedLeague = String(placedTrade.ticker || '').match(/^KX([A-Z]+)TEAMTOTAL-/i)?.[1] || '';
          savedProfile = await updateSeasonProfile(root, profile.id, {
            selectedLines: [{
              ticker: placedTrade.ticker, event: placedTrade.matchup || '', team: selectedTeam,
              league: selectedLeague, line: placedTrade.line ?? null, side: placedTrade.side || '', week: currentWeek,
              sourceRecordId: placedTrade.sourceRecordId, placedTradeId: placedTrade.id, playBoxStatus: 'committed',
            }],
            selectionResolution: {
              ...(profile.selectionResolution || {}),
              status: 'committed', phase: 'placed-from-dashboard', resolvedAt: placedTrade.timestamp || new Date().toISOString(), week: currentWeek,
              selectedGames: 1, message: 'Existing Dashboard bet linked to this season piece.',
            },
          });
        }
        const committed = trades.some((trade) => trade.week === currentWeek && /^(open|pending|placed|submitted)$/i.test(String(trade.status || '')));
        const confirmedReturns = trades.reduce((sum, trade) => sum + (trade.walletReturnConfirmed === true ? (Number(trade.walletReturnedAmount) || 0) : 0), 0);
        const currentWorth = confirmedWalletReturns(trades);
        return { id: profile.id, profile: savedProfile, earnings: currentWorth, committed };
      }));
      const currentProfiles = pieceEntries.map((entry) => entry.profile);
      if (!cancelled) {
        setSeasonProfiles(currentProfiles.filter((profile) => profile.activePlayer !== false && String(profile.status || 'active').toLowerCase() === 'active'));
        setPieceEarnings(Object.fromEntries(pieceEntries.map((entry) => [entry.id, entry.earnings])));
        setPieceCommitments(Object.fromEntries(pieceEntries.map((entry) => [entry.id, entry.committed])));
      }
      if (!cancelled) {
        setPlacedRecordIds(all.filter((item) => item.sourceRecordId).map((item) => item.sourceRecordId));
        setRecords(all.filter((item) => !['dashboard-record', 'play-box'].includes(item.source) && !(item.isQualifiedCandidate && String(item.finalVerdict || '').toUpperCase() === 'REJECT')));
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
    if (profile.paperMode !== true && !kalshiConnected) { setRecordActionMessage((old) => ({ ...old, [record.id]: 'Connect Kalshi before queuing a live order.' })); return; }
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
      await onAddToPlayBox?.(profile, {
        id: record.id, sourceRecordId: record.id, ticker: record.ticker,
        event: record.event || record.matchup || '', team: String(record.team || record.market || '').replace(/\s+over\s+.*$/i, '').trim(),
        league: record.league || String(record.ticker || '').match(/^KX([A-Z]+)TEAMTOTAL-/i)?.[1] || '', line: record.line ?? null, side: record.side || '',
        market: record.market || '', matchup: record.matchup || '',
        price, probability: (Number(record.modelProbability ?? record.probability) || 0) > 1 ? (Number(record.modelProbability ?? record.probability) / 100) : (Number(record.modelProbability ?? record.probability) || 0),
        marketProbability: record.marketProbability ?? null, modelProbability: record.modelProbability ?? ((Number(record.probability) || 0) > 1 ? Number(record.probability) / 100 : record.probability) ?? null,
        edge: record.edge ?? null, finalInterrogation: record.finalInterrogation || null,
        resolutionDetails: record.finalInterrogation || record.context || null,
        source: 'dashboard-record',
      });
      setRecordActionMessage((old) => ({ ...old, [record.id]: 'Added to Play Box · ' + profile.name }));
      onActivity?.('PLAY_BOX_ADD', 'Dashboard selection queued · ' + (record.market || record.matchup) + ' · ' + profile.name);
    } catch (error) {
      setRecordActionMessage((old) => ({ ...old, [record.id]: error.message || 'Could not add this selection to Play Box.' }));
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
      <section className="panel play-box-panel">
        <div className="panel-heading"><div><h2>Play Box · {playBox.length}</h2><p>Selections are staged here. No bets are committed until you commit the full box.</p></div><button className="primary-btn" disabled={!playBox.length || committingPlayBox} onClick={onCommitPlayBox}>{committingPlayBox ? 'Committing…' : 'Commit Play Box'}</button></div>
        {playBox.length ? (
          <div className="table-wrap"><table><thead><tr><th>PIECE</th><th>MATCHUP</th><th>CONTRACT</th><th>ALLOCATION / COMBINED TOTAL</th><th>STATUS</th><th></th></tr></thead><tbody>{playBox.map((item) => <tr key={item.id}><td>{item.pieceName}</td><td>{item.matchup || item.event}</td><td>{item.side} {item.line} · {item.ticker}</td><td>$ {Number(item.allocation || 0).toFixed(2)} · Combined line total: $ {playBox.filter((entry) => entry.ticker === item.ticker && entry.side === item.side && entry.line === item.line && entry.paper === item.paper).reduce((sum, entry) => sum + Number(entry.allocation || 0), 0).toFixed(2)}</td><td><span className="status-pill">In Play Box · {item.paper ? 'Paper' : 'Live'}</span></td><td><button className="danger-text-btn" onClick={async () => { try { await onRemoveFromPlayBox?.(item); } catch (error) { window.alert(error.message || 'Could not remove Play Box item.'); } }}>Remove</button></td></tr>)}</tbody></table></div>
        ) : <div className="empty-state"><b>Play Box is empty</b><span>Add selections from Dashboard records or the AI piece selection.</span></div>}
        {records.length ? (
          <div className="table-wrap"><table><thead><tr><th>RECORDED</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>MODEL PROB.</th><th>PRICE</th><th>PAYOUT</th><th>STATUS</th><th>PLACE BET</th><th>ACTION</th></tr></thead><tbody>
            {records.map((r) => {
              const price = Number(r.price);
              const payout = price > 0 ? (100 / price).toFixed(2) + 'x' : '—';
              const eligiblePieces = seasonProfiles.filter((p) => p.activePlayer !== false && String(p.status || 'active').toLowerCase() === 'active' && Number(p.quotaValue ?? p.initialBalance ?? p.balance) > 0 && pieceCommitments[p.id] !== true && !playBox.some((item) => item.profileId === p.id));
              const selectedId = selectedPieceByRecord[r.id] || '';
              const selectedPiece = eligiblePieces.find((p) => p.id === selectedId);
              const committed = selectedPiece ? pieceCommitments[selectedPiece.id] === true : false;
              const alreadyPlaced = !!r.placedTradeId || placedRecordIds.includes(r.id);
              const queuedForPiece = playBox.some((item) => item.profileId === selectedId && item.sourceRecordId === r.id);
              const canQueueSelection = !!selectedPiece && !committed && !alreadyPlaced && !!r.ticker && price > 0 && price < 100 && (selectedPiece.paperMode === true || kalshiConnected);
              return <tr key={r.id}>
                <td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.matchup}</td><td>{r.market}</td><td>{r.side}</td>
                <td>{r.modelProbability == null ? (r.probability + '%') : Math.round(Number(r.modelProbability) * 100) + '%'}</td>
                <td>{r.price}¢</td><td>{payout}</td><td><span className="status-pill">{r.status || 'open'}</span></td>
                <td><div className="record-place-control">
                  <select value={selectedId} onChange={(event) => setSelectedPieceByRecord((old) => ({ ...old, [r.id]: event.target.value }))}>
                    <option value="">Select piece</option>
                    {eligiblePieces.map((p) => <option key={p.id} value={p.id}>{p.name + ' · ' + (p.paperMode ? 'Paper' : 'Live') + ' · ' + String.fromCharCode(36) + Number(p.quotaValue ?? p.initialBalance ?? p.balance).toFixed(2) + (pieceCommitments[p.id] ? ' · Committed' : '')}</option>)}
                  </select>
                  <button className="secondary-btn" disabled={!selectedPiece || placingRecordId === r.id || alreadyPlaced || queuedForPiece || !canQueueSelection} onClick={() => placeDashboardRecord(r)}>{placingRecordId === r.id ? 'Adding…' : queuedForPiece ? 'In Play Box' : selectedPiece ? 'Add to Play Box' : 'Select piece'}</button>
                  {recordActionMessage[r.id] && <small className="record-action-message">{recordActionMessage[r.id]}</small>}
                  {committed && <small className="record-action-message">Piece already committed this week.</small>}
                  {queuedForPiece && <small className="record-action-message">This piece is in the Play Box.</small>}{alreadyPlaced && <small className="record-action-message">Already committed.</small>}
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
  const [playBox, setPlayBox] = useState([]);
  const [committingPlayBox, setCommittingPlayBox] = useState(false);
  const [autoPlayLock, setAutoPlayLock] = useState(false);

  useEffect(() => {
    if (!dataFolder?.handle) { setPlayBox([]); return; }
    readPlayBox(dataFolder.handle).then(setPlayBox).catch(() => setPlayBox([]));
  }, [dataFolder, refreshKey]);

  // Resolve paper selections and live orders every minute while the app is open.
  useEffect(() => {
    const root = dataFolder?.handle;
    if (!root) return undefined;
    let cancelled = false;
    let running = false;
    const checkResolutions = async () => {
      if (cancelled || running) return;
      running = true;
      let changed = false;
      try {
        const profiles = await listSeasonProfiles(root);
        const activeProfiles = profiles.filter((profile) =>
          profile.activePlayer !== false && String(profile.status || 'active').toLowerCase() === 'active'
        );
        const tradesByProfile = await Promise.all(activeProfiles.map(async (profile) => [profile, await readSeasonTrades(root, profile)]));
        const work = [];
        for (const [profile, trades] of tradesByProfile) {
          const trackedSelections = new Set(trades.filter((trade) => trade.ticker).map((trade) => String(trade.ticker) + '|' + String(trade.week || 'week1')));
          for (const trade of trades) {
            if (!trade.ticker || ['closed','resolved','lost','won','unfilled','cancelled','canceled'].includes(String(trade.status || '').toLowerCase()) ||
                String(trade.resolutionStatus || '').toLowerCase() === 'resolved') continue;
            work.push({ profile, trade, paper: trade.paper === true, source: 'trade' });
          }
          // Only committed trades are monitored; Play Box selections are not exposure.
        }

        const live = work.filter((entry) => !entry.paper && entry.trade.orderId);
        const orderById = new Map();
        if (live.length) {
          try {
            const statuses = await fetchKalshiOrderStatuses(root, live.map(({ trade }) => trade.orderId));
            statuses.forEach((order) => orderById.set(order.orderId, order));
          } catch (error) {
            console.warn('Kalshi live fill verification failed:', error);
          }
        }

        // Refresh authoritative Kalshi market status/result first. A settled YES/NO
        // result takes precedence; scoreboard FINAL is the fallback for closed markets
        // whose settlement result has not propagated yet.
        const tickers = [...new Set(work.map(({ trade }) => trade.ticker))];
        const marketByTicker = new Map();
        try {
          const markets = await fetchMarketResolutions(tickers);
          markets.forEach((market) => marketByTicker.set(market.ticker, market));
        } catch (error) {
          console.warn('Kalshi market resolution lookup failed:', error);
        }
        const scoreGames = work.map(({ trade }) => ({
          ticker: trade.ticker, league: trade.league,
          team: trade.team, opponent: trade.opponent,
          line: trade.line, side: trade.side, gameTime: trade.gameTime,
        }));
        const scoreByTicker = new Map();
        try {
          const scores = await fetchGameScoreResolutions(scoreGames);
          scores.forEach((score) => scoreByTicker.set(score.ticker, score));
        } catch (error) {
          console.warn('Game score lookup failed:', error);
        }

        for (const entry of work) {
          const { profile, trade, paper, source } = entry;
          const market = marketByTicker.get(trade.ticker);
          const score = scoreByTicker.get(trade.ticker);
          const marketStatus = String(market?.status || '').toLowerCase();
          const marketResult = String(market?.result || '').toLowerCase();
          let won = null;
          let resolutionSource = '';
          let result = '';
          if (['yes','no'].includes(marketResult)) {
            const actualYes = marketResult === 'yes';
            won = String(trade.side).toUpperCase() === 'YES' ? actualYes : !actualYes;
            result = marketResult;
            resolutionSource = 'kalshi-market-settlement';
          } else if (score?.verified && score?.resolved && score.status === 'FINAL' && typeof score.won === 'boolean') {
            won = score.won;
            result = score.actualYes ? 'yes' : 'no';
            resolutionSource = 'verified-final-score';
          }

          if (!paper) {
            const order = orderById.get(trade.orderId);
            if (order && !order.error) {
              const fillCount = Number(order.fill_count) || 0;
              const remainingCount = Number(order.remaining_count) || 0;
              await updateTradeRecord(root, trade.id, {
                fillCount, remainingCount, kalshiOrderStatus: order.status,
                orderLifecycle: fillCount > 0 && remainingCount > 0 ? 'partially-filled' :
                  fillCount > 0 ? 'filled' :
                  /cancel|expire|reject/i.test(String(order.status || '')) ? 'unfilled' : 'open',
              });
              trade.fillCount = fillCount;
              trade.remainingCount = remainingCount;
              trade.kalshiOrderStatus = order.status;
              if (fillCount <= 0 && /cancel|expire|reject/i.test(String(order.status || ''))) {
                await updateTradeRecord(root, trade.id, { status: 'unfilled', resolutionStatus: 'not-applicable', walletReturnConfirmed: false });
                await updateSeasonProfile(root, profile.id, {
                  selectedLines: [],
                  selectionResolution: { ...(profile.selectionResolution || {}), status: 'unfilled', phase: 'order-ended-unfilled', message: 'Live order ended without any filled contracts.' },
                });
                changed = true;
                continue;
              }
              if (fillCount <= 0) continue;
            } else {
              // Never infer live exposure from an accepted order alone. Wait until fills
              // can be verified from Kalshi before scoring or retiring the piece.
              continue;
            }
          }

          if (typeof won !== 'boolean') continue;
          const resolvedAt = new Date().toISOString();
          const priceCents = Number(trade.price) || Number(trade.marketProbability) * 100;
          const filledContracts = paper
            ? (Number(trade.stake) > 0 && priceCents > 0 ? Number(trade.stake) / (priceCents / 100) : 0)
            : Math.max(0, Number(trade.fillCount) || 0);
          const payout = won ? Math.round(filledContracts * 100) / 100 : 0;
          let resolvedTrade = trade;
          if (source === 'selected-line') {
            await appendTrade(root, profile.season, trade.week, {
              ...trade, id: trade.id, timestamp: resolvedAt, source: 'paper-selected-line', seasonPieceId: profile.id,
              status: won ? 'closed' : 'lost', outcome: won ? 'won' : 'lost',
              resolutionStatus: 'resolved', resolutionResult: result,
              resolutionMarketStatus: marketStatus || score?.status || 'FINAL',
              scoreVerified: resolutionSource === 'verified-final-score',
              scoreTeam: score?.team || trade.team, scoreOpponent: score?.opponent || trade.opponent,
              scoreTeamPoints: score?.teamScore ?? null, scoreOpponentPoints: score?.opponentScore ?? null,
              scoreLine: trade.line, scoreSide: trade.side, scoreComparison: score?.comparison || ('Kalshi settled ' + result),
              resolvedAt, walletReturnConfirmed: won, walletReturnedAmount: payout, payout,
            });
            resolvedTrade = await updateTradeRecord(root, trade.id, {
              status: won ? 'closed' : 'lost', outcome: won ? 'won' : 'lost',
              resolutionStatus: 'resolved', resolutionResult: result,
              resolutionMarketStatus: marketStatus || score?.status || 'FINAL',
              resolutionSource, scoreVerified: resolutionSource === 'verified-final-score',
              scoreEventId: score?.event?.eventId || null, scoreEventName: score?.event?.eventName || null,
              scoreTeam: score?.team || trade.team, scoreOpponent: score?.opponent || trade.opponent,
              scoreTeamPoints: score?.teamScore ?? null, scoreOpponentPoints: score?.opponentScore ?? null,
              scoreLine: trade.line, scoreSide: trade.side, scoreComparison: score?.comparison || ('Kalshi settled ' + result),
              resolvedAt, walletReturnConfirmed: won, walletReturnedAmount: payout, payout,
            });
          } else {
            resolvedTrade = await updateTradeRecord(root, trade.id, {
              status: won ? 'closed' : 'lost', outcome: won ? 'won' : 'lost',
              resolutionStatus: 'resolved', resolutionResult: result,
              resolutionMarketStatus: marketStatus || score?.status || 'FINAL',
              resolutionSource, scoreVerified: resolutionSource === 'verified-final-score',
              scoreEventId: score?.event?.eventId || null, scoreEventName: score?.event?.eventName || null,
              scoreTeam: score?.team || trade.team, scoreOpponent: score?.opponent || trade.opponent,
              scoreTeamPoints: score?.teamScore ?? null, scoreOpponentPoints: score?.opponentScore ?? null,
              scoreLine: trade.line, scoreSide: trade.side, scoreComparison: score?.comparison || ('Kalshi settled ' + result),
              resolvedAt, walletReturnConfirmed: won, walletReturnedAmount: payout, payout,
            });
          }
          if (!resolvedTrade) continue;
          const profileTrades = (await readSeasonTrades(root, profile)).map((item) => item.id === trade.id ? resolvedTrade : item);
          if (won) {
            const earnedWorth = confirmedWalletReturns(profileTrades);
            let updated = await updateSeasonProfile(root, profile.id, {
              currentWorth: Math.round(earnedWorth * 100) / 100,
              selectedLines: [],
              lastPayout: payout, lastResolvedAt: resolvedAt,
              lastResolvedMatch: trade.matchup || trade.market || trade.ticker,
              selectionResolution: { ...(profile.selectionResolution || {}), status: 'won', phase: 'market-settled', resolvedAt, payout, result, resolutionSource, message: 'Selected position settled in the piece’s favor.' },
            });
            updated = await advanceSeasonWeek(root, updated);
          } else {
            const updated = await updateSeasonProfile(root, profile.id, {
              activePlayer: false, status: 'inactive',
              currentWorth: confirmedWalletReturns(profileTrades), selectedLines: [],
              inactiveSince: resolvedAt,
              inactiveReason: (score?.comparison || ('Kalshi market settled ' + result)) + '; selected ' + String(trade.side).toUpperCase() + ' did not win.',
              selectionResolution: { ...(profile.selectionResolution || {}), status: 'lost', phase: 'market-settled', resolvedAt, result, resolutionSource, message: 'Selected position did not win.' },
            });
            await archiveInactivePiece(root, updated, profileTrades, updated.inactiveReason);
            break;
          }
          changed = true;
        }
      } catch (error) {
        console.warn('Season resolution check failed:', error);
      } finally {
        running = false;
        if (!cancelled && changed) setRefreshKey((value) => value + 1);
      }
    };
    checkResolutions();
    const timer = window.setInterval(checkResolutions, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [dataFolder]);


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

  const ladderKeyFor = (item) => [String(item.ticker || '').replace(/-[^-]+$/, '') || item.event || item.matchup || '', item.team || '', item.league || ''].join('|').toLowerCase();
  const handleAddToPlayBox = useCallback(async (profile, selection) => {
    if (!dataFolder?.handle || !profile?.id) throw new Error('Connect a data folder and select a season piece first.');
    if (profile.paperMode !== true && !kalshiAccount?.connected) throw new Error('Connect your Kalshi account before queuing a live order.');
    const current = await readPlayBox(dataFolder.handle);
    if (current.some((item) => item.profileId === profile.id)) throw new Error(profile.name + ' already has a selection in the Play Box.');
    const ladderKey = ladderKeyFor(selection);
    const conflictingLine = current.find((item) => ladderKeyFor(item) === ladderKey && (String(item.ticker) !== String(selection.ticker) || String(item.side) !== String(selection.side)));
    if (conflictingLine) throw new Error('This ladder already has a different line or side in the Play Box. Kalshi orders are grouped only for the same contract.');
    const trades = await readSeasonTrades(dataFolder.handle, profile);
    const week = profile.nextScheduledWeek || 'week1';
    const selectedStatus = String(profile.selectedLines?.[0]?.playBoxStatus || '').toLowerCase();
    const resolutionStatus = String(profile.selectionResolution?.status || '').toLowerCase();
    if (selectedStatus === 'committed' || resolutionStatus === 'committed' ||
        trades.some((trade) => trade.week === week && !/^(unfilled|cancelled|canceled)$/i.test(String(trade.status || '')) &&
          !/^(resolved|not-applicable)$/i.test(String(trade.resolutionStatus || '')))) {
      throw new Error('This piece already has a committed bet and cannot be added to the Play Box.');
    }
    const item = {
      ...selection,
      id: 'play-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(16).slice(2)),
      profileId: profile.id, pieceName: profile.name, season: profile.season, week,
      paper: profile.paperMode === true, allocation: Math.round(Number(profile.originalAllocation ?? profile.initialBalance ?? profile.balance ?? profile.quotaValue) * 100) / 100,
      addedAt: new Date().toISOString(), ladderKey,
    };
    const next = [...current, item];
    const previousSelection = profile.selectedLines || [];
    const previousResolution = profile.selectionResolution || {};
    const selectedLine = { predictionKey: selection.predictionKey || null, ticker: selection.ticker, event: selection.event || selection.matchup || '', team: selection.team || '', opponent: selection.opponent || '', league: selection.league || '', line: selection.line ?? null, side: selection.side || '', gameTime: selection.gameTime || null, week, playBoxItemId: item.id, playBoxStatus: 'in-play-box', sourceRecordId: selection.sourceRecordId || null };
    await updateSeasonProfile(dataFolder.handle, profile.id, { selectedLines: [selectedLine], selectionResolution: { ...previousResolution, status: 'in-play-box', phase: 'queued-for-batch-commit', resolvedAt: new Date().toISOString(), week, selectedGames: 1, message: 'Selection staged in Play Box; no bet has been committed.' } });
    try { await writePlayBox(dataFolder.handle, next); }
    catch (error) {
      await updateSeasonProfile(dataFolder.handle, profile.id, { selectedLines: previousSelection, selectionResolution: previousResolution });
      throw error;
    }
    setPlayBox(next);
    handleActivity();
    return item;
  }, [dataFolder, handleActivity, kalshiAccount]);

  const handleRemoveFromPlayBox = useCallback(async (item) => {
    if (!dataFolder?.handle) return;
    const current = await readPlayBox(dataFolder.handle);
    const next = current.filter((entry) => entry.id !== item.id);
    const profiles = await listSeasonProfiles(dataFolder.handle);
    const profile = profiles.find((entry) => entry.id === item.profileId);
    const shouldClear = profile?.selectedLines?.[0]?.playBoxItemId === item.id && profile.selectedLines[0].playBoxStatus === 'in-play-box';
    if (shouldClear) {
      await updateSeasonProfile(dataFolder.handle, profile.id, { selectedLines: [], selectionResolution: { ...(profile.selectionResolution || {}), status: 'none', phase: 'removed-from-play-box', selectedGames: 0, message: 'Selection removed from Play Box.' } });
    }
    try { await writePlayBox(dataFolder.handle, next); }
    catch (error) {
      if (shouldClear) await updateSeasonProfile(dataFolder.handle, profile.id, { selectedLines: profile.selectedLines, selectionResolution: profile.selectionResolution || {} });
      throw error;
    }
    setPlayBox(next); handleActivity();
  }, [dataFolder, handleActivity]);

  const handleCommitPlayBox = useCallback(async () => {
    if (!dataFolder?.handle || !playBox.length || committingPlayBox) return;
    if (playBox.some((item) => item.paper !== true) && !kalshiAccount?.connected) {
      window.alert('Connect Kalshi before committing live Play Box items. No live orders were sent.');
      return;
    }
    const ladderContracts = new Map();
    for (const item of playBox) {
      const ladderKey = item.ladderKey || ladderKeyFor(item);
      const contract = String(item.ticker) + '|' + String(item.side);
      const previous = ladderContracts.get(ladderKey);
      if (previous && previous !== contract) {
        window.alert('Play Box contains two different lines or sides on the same ladder. Remove one before committing.');
        return;
      }
      ladderContracts.set(ladderKey, contract);
      if (!item.ticker || !['YES', 'NO'].includes(String(item.side).toUpperCase()) || !(Number(item.allocation) > 0)) {
        window.alert('Play Box contains an incomplete contract or allocation. No bets were committed.');
        return;
      }
    }
    const groups = new Map();
    for (const item of playBox) {
      const key = [item.paper ? 'paper' : 'live', item.ticker, item.side, item.line].join('|');
      const group = groups.get(key) || [];
      group.push(item); groups.set(key, group);
    }
    const hashId = (value) => {
      let hash = 2166136261;
      for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
      return 'agt-' + (hash >>> 0).toString(16);
    };
    setCommittingPlayBox(true);
    try {
      const liveGroups = [...groups.entries()].filter(([, items]) => items[0].paper !== true);
      const liveRequests = liveGroups.filter(([, items]) => !items.every((item) => item.kalshiOrderId)).map(([key, items]) => {
        const totalStake = items.reduce((sum, item) => sum + Number(item.allocation || 0), 0);
        const cost = Number(items[0].marketProbability ?? (Number(items[0].price) / 100));
        if (!(cost > 0 && cost < 1)) throw new Error('Missing saved executable ask for ' + items[0].ticker);
        const count = Math.floor((totalStake / cost) * 100) / 100;
        if (!(count >= 0.01)) throw new Error('Combined allocation is too small to buy 0.01 contracts for ' + items[0].ticker);
        const yesBookPrice = items[0].side === 'NO' ? 1 - cost : cost;
        const clientOrderId = hashId(key + '|' + items.map((item) => item.id).sort().join('|'));
        return {
          key, items, clientOrderId, totalStake,
          order: { ticker: items[0].ticker, client_order_id: clientOrderId, side: items[0].side === 'NO' ? 'ask' : 'bid', count: count.toFixed(2), price: yesBookPrice.toFixed(4) },
        };
      });
      const liveResults = liveRequests.length ? await submitKalshiOrders(dataFolder.handle, liveRequests.map((item) => item.order)) : [];
      const liveResultById = new Map(liveResults.map((result) => [result.client_order_id, result]));
      const confirmedQueue = playBox.map((item) => {
        const request = liveRequests.find((entry) => entry.items.some((candidate) => candidate.id === item.id));
        const result = request ? liveResultById.get(request.clientOrderId) : null;
        return result?.submitted && result?.order_id
          ? { ...item, kalshiOrderId: result.order_id, kalshiClientOrderId: result.client_order_id, kalshiOrderConfirmation: result }
          : item;
      });
      if (confirmedQueue.some((item, index) => item !== playBox[index])) {
        await writePlayBox(dataFolder.handle, confirmedQueue);
        setPlayBox(confirmedQueue);
      }
      const successfulIds = new Set();
      const failedGroups = [];
      for (const [key, items] of groups) {
        const isPaper = items[0].paper === true;
        const liveRequest = liveRequests.find((entry) => entry.key === key);
        const savedOrder = items.every((item) => item.kalshiOrderId) ? items[0] : null;
        const liveResult = savedOrder ? { submitted: true, order_id: savedOrder.kalshiOrderId, client_order_id: savedOrder.kalshiClientOrderId, ...(savedOrder.kalshiOrderConfirmation || {}) } : liveRequest ? liveResultById.get(liveRequest.clientOrderId) : null;
        if (!isPaper && (!liveResult?.submitted || !liveResult?.order_id)) {
          failedGroups.push({ key, error: liveResult?.error || 'Kalshi did not confirm an order ID.' });
          continue;
        }
        const orderGroupId = liveRequest?.clientOrderId || items[0].kalshiClientOrderId || hashId(key + '|' + items.map((item) => item.id).sort().join('|'));
        const totalStake = Math.round(items.reduce((sum, item) => sum + Number(item.allocation || 0), 0) * 100) / 100;
        const sharedResolution = items[0].resolutionDetails || items[0].finalInterrogation || null;
        for (const item of items) {
          const profiles = await listSeasonProfiles(dataFolder.handle);
          const profile = profiles.find((entry) => entry.id === item.profileId);
          if (!profile) throw new Error('Season piece not found during commit: ' + item.pieceName);
          const existing = await readSeasonTrades(dataFolder.handle, profile);
          const tradeId = 'playbox-trade-' + item.id;
          if (!existing.some((trade) => trade.id === tradeId)) {
            await appendTrade(dataFolder.handle, item.season, item.week, {
              id: tradeId, timestamp: new Date().toISOString(), matchup: item.matchup || item.event || '', market: item.market || item.team || '', side: item.side,
              price: Number(item.price) || Number(item.marketProbability) * 100, probability: Math.round(Number(item.probability ?? item.modelProbability ?? 0) * 100),
              stake: Number(item.allocation) || 0, paper: isPaper, status: isPaper ? 'open' : 'submitted', ticker: item.ticker, line: item.line, team: item.team || '', opponent: item.opponent || profile.selectedLines?.[0]?.opponent || '', league: item.league || '', gameTime: item.gameTime || profile.selectedLines?.[0]?.gameTime || null,
              marketProbability: item.marketProbability ?? (Number(item.price) / 100), modelProbability: item.modelProbability ?? item.probability ?? null,
              edge: item.edge ?? null, seasonPieceId: profile.id, week: item.week, sourceRecordId: item.sourceRecordId || null,
              payoutMultiple: Number(item.price) > 0 ? 100 / Number(item.price) : null, source: 'play-box', orderGroupId,
              playBoxItemId: item.id, resolutionDetails: sharedResolution, combinedOrderStake: totalStake,
              orderId: liveResult?.order_id || null, clientOrderId: liveRequest?.clientOrderId || items[0].kalshiClientOrderId || null,
              fillCount: liveResult?.fill_count ?? null, remainingCount: liveResult?.remaining_count ?? null,
            });
          }
          const line = { ...(profile.selectedLines?.[0] || {}), ticker: item.ticker, event: item.event || item.matchup || '', team: item.team || '', opponent: item.opponent || profile.selectedLines?.[0]?.opponent || '', league: item.league || '', line: item.line, side: item.side, gameTime: item.gameTime || profile.selectedLines?.[0]?.gameTime || null, week: item.week, playBoxItemId: item.id, playBoxStatus: 'committed', orderGroupId, placedTradeId: tradeId, orderId: liveResult?.order_id || null, resolutionDetails: sharedResolution };
          await updateSeasonProfile(dataFolder.handle, profile.id, { selectedLines: [line], selectionResolution: { ...(profile.selectionResolution || {}), status: 'committed', phase: isPaper ? 'paper-order-confirmed' : 'kalshi-order-confirmed', resolvedAt: new Date().toISOString(), week: item.week, selectedGames: 1, orderGroupId, orderId: liveResult?.order_id || null, combinedOrderStake: totalStake, message: (isPaper ? 'Paper bet committed.' : 'Kalshi order accepted.') + ' Shared order group: ' + orderGroupId } });
          successfulIds.add(item.id);
        }
      }
      const remaining = playBox.filter((item) => !successfulIds.has(item.id));
      await writePlayBox(dataFolder.handle, remaining);
      setPlayBox(remaining);
      handleActivity();
      if (failedGroups.length) window.alert(failedGroups.length + ' order group(s) were not confirmed. Successful groups were committed; failed selections remain in the Play Box. ' + failedGroups.map((item) => item.error).join(' | '));
    } catch (error) {
      window.alert('Play Box commit stopped: ' + (error.message || String(error)) + '. Items not confirmed remain queued.');
    } finally { setCommittingPlayBox(false); }
  }, [dataFolder, playBox, committingPlayBox, handleActivity, kalshiAccount, ladderKeyFor]);

  const handleScanResolved = useCallback(async (result = {}) => {
    if (result.autoPlay && dataFolder?.handle && result.profileId) {
      try {
        const profiles = await listSeasonProfiles(dataFolder.handle);
        const profile = profiles.find((item) => item.id === result.profileId);
        if (profile) {
          const attempts = Math.max(0, Number(profile.autoAttempts) || 0);
          const patch = result.selected
            ? { autoAttempts: 0, autoTimeoutUntil: null, autoLastResult: 'selected' }
            : attempts >= 3
              ? { autoAttempts: 0, autoTimeoutUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), autoLastResult: result.reason || 'no-selection' }
              : { autoLastResult: result.reason || 'no-selection' };
          await updateSeasonProfile(dataFolder.handle, profile.id, patch);
        }
      } catch (error) { console.warn('Auto-play attempt state could not be saved:', error); }
    }
    setAutoPlayLock(false); setScanRequest(null); setActive('Dashboard'); handleActivity();
  }, [dataFolder, handleActivity]);

  const handleStartWeek = useCallback(async (profile) => {
    if (!dataFolder?.handle || !profile) return;
    try {
      // Reset Dashboard records before advancing the piece or starting its scan.
      await clearDashboardRecords(dataFolder.handle);
      const existingTrades = await readSeasonTrades(dataFolder.handle, profile);
      const scheduledProfile = existingTrades.length === 0 && profile.nextScheduledWeek !== 'week1'
        ? await updateSeasonProfile(dataFolder.handle, profile.id, { nextScheduledWeek: 'week1' })
        : profile;
      handleActivity();
      setAutoPlayLock(profile.auto === true);
      setScanRequest({ profileId: scheduledProfile.id, requestId: scheduledProfile.id + '-' + Date.now(), autoPlay: profile.auto === true });
      setActive('AI Predictions');
    } catch (e) {
      console.error(e);
    }
  }, [dataFolder, handleActivity]);

  // Auto mode selects one eligible active piece at random every minute.
  useEffect(() => {
    const root = dataFolder?.handle;
    if (!root) return undefined;
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (cancelled || running || autoPlayLock || scanRequest || committingPlayBox) return;
      running = true;
      try {
        const profiles = await listSeasonProfiles(root);
        const queue = await readPlayBox(root);
        const candidates = [];
        for (let profile of profiles) {
          if (profile.auto !== true || profile.activePlayer === false || String(profile.status || 'active').toLowerCase() !== 'active') continue;
          const timeout = Date.parse(profile.autoTimeoutUntil || '');
          if (Number.isFinite(timeout) && timeout > Date.now()) continue;
          if (Number.isFinite(timeout) && timeout <= Date.now()) {
            profile = await updateSeasonProfile(root, profile.id, { autoAttempts: 0, autoTimeoutUntil: null });
          }
          if (queue.some((item) => item.profileId === profile.id)) continue;
          const week = profile.nextScheduledWeek || 'week1';
          const trades = await readSeasonTrades(root, profile);
          const committed = trades.some((trade) => trade.week === week &&
            !/^(unfilled|cancelled|canceled)$/i.test(String(trade.status || '')) &&
            !/^(resolved|not-applicable)$/i.test(String(trade.resolutionStatus || '')));
          const lineStatus = String(profile.selectedLines?.[0]?.playBoxStatus || '').toLowerCase();
          const resolutionStatus = String(profile.selectionResolution?.status || '').toLowerCase();
          if (committed || lineStatus === 'committed' || resolutionStatus === 'committed' || lineStatus === 'in-play-box') continue;
          candidates.push(profile);
        }
        if (candidates.length) {
          const profile = candidates[Math.floor(Math.random() * candidates.length)];
          const attempts = (Number(profile.autoAttempts) || 0) + 1;
          const attempted = await updateSeasonProfile(root, profile.id, { autoAttempts: attempts, autoLastAttemptAt: new Date().toISOString() });
          await handleStartWeek({ ...attempted, auto: true, autoAttempts: attempts });
        }
      } catch (error) { console.warn('Auto-play scheduler failed:', error); }
      finally { running = false; }
    };
    const timer = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [dataFolder, autoPlayLock, scanRequest, committingPlayBox, refreshKey]);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={21}/></div><div className="brand-text"><b>AngelicGTrader</b><small>SPORTS INTELLIGENCE</small></div><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <nav>{groups.map(group => {
        const items = filtered.filter(n => n.group === group);
        return items.length ? <div className="nav-group" key={group}><div className="nav-label">{group}</div>{items.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${active === item.label ? 'active' : ''}`} disabled={autoPlayLock} onClick={() => {setActive(item.label);setSidebarOpen(false);}}><Icon size={17}/><span>{item.label}</span>{active === item.label && <span className="active-bar"/>}</button>; })}</div> : null;
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
        <button className="mobile-menu" disabled={autoPlayLock} onClick={() => setSidebarOpen(true)}><Menu size={19}/></button>
        <div className="breadcrumb">Workspace <ChevronRight size={14}/><b>{active}</b></div>
        <div className="top-actions">
          {kalshiAccount && <div className="header-kalshi-account"><b>{kalshiAccount.accountName}</b><span>${Number(kalshiAccount.balanceDollars || 0).toFixed(2)}</span></div>}
          <PaperModeToggle enabled={paperMode} onChange={handlePaperToggle} disabled={!dataFolder?.handle || !kalshiAccount?.connected} />
          <a className="header-doc-btn" title="Documentation" href="https://github.com/FOneEleven/AngelicGTrader/blob/main/README.md" target="_blank" rel="noreferrer"><FileText size={16}/><span>Docs</span></a>
          <button className="icon-btn" title="Notifications"><Bell size={17}/></button>
        </div>
      </header>
      {autoPlayLock && <div className="auto-play-lock-banner"><RefreshCw size={17} className="spin"/><b>Auto play is resolving.</b> Please wait while the season piece completes its selection. Navigation is disabled.</div>}
      <div className="page-content">
        {active === 'Dashboard' && (
          <>
            <DataFolderConnect onFolderReady={setDataFolder} onAccountChange={(account) => { setKalshiAccount(account); if (!account?.connected) handlePaperToggle(true); }} />
            <Dashboard dataFolder={dataFolder} activityFilter={activityFilter} onActivityFilter={setActivityFilter} refreshKey={refreshKey} paperMode={paperMode} onNavigate={setActive} onActivity={handleActivity} onStartWeek={handleStartWeek} playBox={playBox} onAddToPlayBox={handleAddToPlayBox} onRemoveFromPlayBox={handleRemoveFromPlayBox} onCommitPlayBox={handleCommitPlayBox} committingPlayBox={committingPlayBox} kalshiConnected={!!kalshiAccount?.connected} />
          </>
        )}
        {active === 'Live Market Scanner' && (
          <LiveMarketScanner dataFolder={dataFolder} onActivity={handleActivity} onNavigate={setActive} />
        )}
        {active === 'AI Predictions' && (
          <AIPredictions dataFolder={dataFolder} onActivity={handleActivity} scanRequest={scanRequest} onQueueSelection={handleAddToPlayBox} onScanResolved={handleScanResolved} autoPlayActive={autoPlayLock} />
        )}
        {active === 'Prediction History' && (
          <PredictionHistory dataFolder={dataFolder} refreshKey={refreshKey} />
        )}
        {active === 'Game Day' && (
          <GameDay dataFolder={dataFolder} refreshKey={refreshKey} onActivity={handleActivity} onStartWeek={handleStartWeek} onNavigate={setActive} />
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
