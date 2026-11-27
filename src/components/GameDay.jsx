import React, { useEffect, useMemo, useState } from 'react';
import { Trophy, RefreshCw, X, Users, CalendarDays } from 'lucide-react';
import SeasonToken from './SeasonToken';
import { listSeasonProfiles, readSeasonTrades, updateSeasonProfile, advanceSeasonWeek } from '../lib/dataModel';

const FILTERS = [{ id: 'active', label: 'Active' }, { id: 'all', label: 'All' }, { id: 'winners', label: 'Highest winners' }];
const isLoss = (trade) => /^(lost|loss|settled_loss|settled-loss)$/i.test(String(trade.outcome || trade.status || '')) || Number(trade.earnings ?? trade.profit ?? 0) < 0;

function earningsFor(trades) {
  return trades.reduce((sum, trade) => sum + Number(trade.earnings ?? trade.profit ?? 0), 0);
}

function EarningsGraph({ pieces }) {
  const width = Math.max(560, pieces.length * 150 + 100), height = 300;
  const left = 66, right = 24, top = 22, bottom = 72;
  const plotW = width - left - right, plotH = height - top - bottom;
  const minValue = Math.min(0, ...pieces.map((p) => p.earnings));
  const maxValue = Math.max(10, ...pieces.map((p) => p.earnings));
  const range = Math.max(1, maxValue - minValue);
  const ticks = [0, .25, .5, .75, 1].map((n) => minValue + range * n);
  const slot = pieces.length ? plotW / pieces.length : plotW;
  const barW = Math.min(64, slot * .48);
  const yFor = (value) => top + plotH - ((value - minValue) / range) * plotH;
  const zeroY = yFor(0);
  return <div className="game-day-chart-scroll">
    <svg className="game-day-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Season piece earnings graph">
      {ticks.map((tick, i) => {
        const y = yFor(tick);
        return <g key={i}><line x1={left} x2={width-right} y1={y} y2={y} stroke="#29313d" strokeDasharray="3 5"/><text x={left-12} y={y+4} textAnchor="end" fill="#8992a1" fontSize="10">{'$' + tick.toFixed(0)}</text></g>;
      })}
      <line x1={left} x2={left} y1={top} y2={top+plotH} stroke="#505968"/>
      <line x1={left} x2={width-right} y1={zeroY} y2={zeroY} stroke="#687385"/>
      {pieces.map((piece, i) => {
        const x = left + slot * i + (slot - barW) / 2;
        const valueY = yFor(piece.earnings);
        const barY = Math.min(zeroY, valueY);
        const barH = Math.max(2, Math.abs(zeroY - valueY));
        return <g key={piece.id}>
          <rect x={x} y={barY} width={barW} height={barH} rx="5" fill={piece.baseColor || '#c69d4e'} opacity=".88"/>
          <text x={x+barW/2} y={piece.earnings >= 0 ? Math.max(top+12,barY-8) : Math.min(top+plotH-3,barY+barH+13)} textAnchor="middle" fill="#e6d5a9" fontSize="10">{'$' + piece.earnings.toFixed(2)}</text>
          <text x={x+barW/2} y={top+plotH+19} textAnchor="middle" fill="#cbd0d9" fontSize="10">{piece.pieceType}</text>
          <text x={x+barW/2} y={top+plotH+34} textAnchor="middle" fill="#788394" fontSize="9">{piece.name.length > 18 ? piece.name.slice(0,16)+'…' : piece.name}</text>
        </g>;
      })}
      {!pieces.length && <text x={left+plotW/2} y={top+plotH/2} textAnchor="middle" fill="#8992a1" fontSize="12">No pieces in this view</text>}
      <text x="15" y="15" fill="#8992a1" fontSize="9">EARNINGS ($)</text>
      <text x={left+plotW/2} y={height-10} textAnchor="middle" fill="#8992a1" fontSize="9">SEASON PIECE</text>
    </svg>
  </div>;
}

export default function GameDay({ dataFolder, onActivity }) {
  const root = dataFolder?.handle;
  const [profiles, setProfiles] = useState([]);
  const [tradesByPiece, setTradesByPiece] = useState({});
  const [filter, setFilter] = useState('active');
  const [hiddenIds, setHiddenIds] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  async function load() {
    if (!root) return;
    setError('');
    try {
      let nextProfiles = await listSeasonProfiles(root);
      const entries = await Promise.all(nextProfiles.map(async (profile) => [profile.id, await readSeasonTrades(root, profile)]));
      const map = Object.fromEntries(entries);
      for (const profile of nextProfiles) {
        if (profile.activePlayer !== false && (map[profile.id] || []).some(isLoss)) {
          const updated = await updateSeasonProfile(root, profile.id, { activePlayer: false });
          nextProfiles = nextProfiles.map((p) => p.id === updated.id ? updated : p);
        }
      }
      setProfiles(nextProfiles);
      setTradesByPiece(map);
    } catch (e) { setError(e.message || 'Could not load Game Day data'); }
  }

  useEffect(() => { load(); }, [root]);

  const pieces = useMemo(() => profiles.map((profile) => {
    const trades = tradesByPiece[profile.id] || [];
    return { ...profile, trades, earnings: earningsFor(trades) };
  }), [profiles, tradesByPiece]);

  const visiblePieces = useMemo(() => {
    let rows = pieces.filter((p) => !hiddenIds.includes(p.id));
    if (filter === 'active') rows = rows.filter((p) => p.activePlayer !== false);
    if (filter === 'winners') rows = rows.filter((p) => p.earnings > 0).sort((a,b) => b.earnings - a.earnings).slice(0,5);
    return rows;
  }, [pieces, filter, hiddenIds]);

  async function updatePiece(profile, patch) {
    setBusyId(profile.id);
    try {
      const updated = await updateSeasonProfile(root, profile.id, patch);
      setProfiles((old) => old.map((p) => p.id === updated.id ? updated : p));
      onActivity?.('SEASON_UPDATE', updated.name + ' updated');
    } catch (e) { setError(e.message || 'Could not update season piece'); }
    finally { setBusyId(''); }
  }

  async function startNextWeek(profile) {
    setBusyId(profile.id);
    try {
      const updated = await advanceSeasonWeek(root, profile);
      setProfiles((old) => old.map((p) => p.id === updated.id ? updated : p));
      onActivity?.('WEEK_START', updated.name + ' scheduled for ' + updated.nextScheduledWeek);
    } catch (e) { setError(e.message || 'Could not schedule next week'); }
    finally { setBusyId(''); }
  }

  if (!root) return <div className="page-shell"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>Game Day</h1><p>Season piece earnings and weekly schedules.</p></div></div><div className="empty-state panel"><Trophy size={24}/><b>Connect a data folder</b><span>Game Day reads season pieces and their recorded matches from local storage.</span></div></div>;

  return <div className="page-shell game-day">
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>Game Day</h1><p>Compare earnings, active pieces, and their next scheduled week.</p></div><button className="secondary-btn" onClick={load}><RefreshCw size={14}/> Refresh</button></div>
    {error && <div className="notice error-notice"><b>{error}</b></div>}
    <section className="panel game-day-earnings">
      <div className="panel-heading"><div><h2>Earnings</h2><p>Money earned by each season piece</p></div><div className="game-day-filters">{FILTERS.map((item) => <button key={item.id} className={`seg-btn ${filter === item.id ? 'active' : ''}`} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div></div>
      <EarningsGraph pieces={visiblePieces}/>
      <div className="game-day-chart-foot"><span>{visiblePieces.length} pieces shown</span><button className="text-btn" onClick={() => { setHiddenIds([]); setFilter('all'); }}>Show all pieces</button></div>
      <div className="game-day-piece-list">
        {visiblePieces.map((piece) => <article className="game-day-piece" key={piece.id}>
          <SeasonToken pieceType={piece.pieceType} baseColor={piece.baseColor} size={76}/>
          <div className="game-day-piece-main"><b>{piece.name}</b><span>{piece.activePlayer === false ? 'Inactive' : 'Active'} · {piece.paperMode ? 'Paper' : 'Live'} · {piece.strategy || 'midpoint'}</span><strong>$ {piece.earnings.toFixed(2)} earned</strong><small>Next week: {piece.nextScheduledWeek || 'week1'} · {piece.trades.length} records</small>
            {piece.activePlayer !== false && <div className="season-piece-controls">
              <button className="secondary-btn" disabled={busyId === piece.id} onClick={() => startNextWeek(piece)}>Start next week</button>
              <label className={`auto-switch ${piece.auto ? 'enabled' : ''}`}><input type="checkbox" checked={!!piece.auto} onChange={(e) => updatePiece(piece, { auto: e.target.checked })}/><span className="auto-switch-track"></span><b>Auto</b></label>
            </div>}
          </div>
          <button className="remove-piece-btn" title="Remove piece from this graph" onClick={() => setHiddenIds((old) => [...new Set([...old,piece.id])])}><X size={14}/></button>
        </article>)}
      </div>
    </section>
    <section className="panel game-day-schedule">
      <div className="panel-heading"><div><h2>Next scheduled week</h2><p>Only records linked to their own season piece appear here.</p></div><CalendarDays size={18}/></div>
      {visiblePieces.filter((p) => p.activePlayer !== false).map((piece) => {
        const matches = piece.trades.filter((trade) => trade.week === (piece.nextScheduledWeek || 'week1'));
        return <div className="game-day-schedule-piece" key={piece.id}><div><b>{piece.name}</b><small>{piece.nextScheduledWeek || 'week1'}</small></div>{matches.length ? matches.map((trade) => <div className="game-day-match" key={trade.id}><b>{trade.matchup}</b><span>{trade.market} · {trade.side} · {trade.status}</span></div>) : <span className="game-day-no-matches">No records assigned to this piece for this week yet.</span>}</div>;
      })}
      {!visiblePieces.some((p) => p.activePlayer !== false) && <div className="empty-state"><Users size={22}/><b>No active pieces in this view</b></div>}
    </section>
    <div className="game-day-note">Earnings are calculated from settled record profit/earnings values. Open records do not count as winnings. Auto is a saved piece setting; automated execution is not enabled yet.</div>
  </div>;
}
