import React, { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';
import { readCache } from '../lib/marketCache';
import { readSettings, appendTrade, readTrades } from '../lib/dataModel';
import { computePredictions, DEFAULTS } from '../lib/predictions';

function cents(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v * 100)}¢`;
}
function closesIn(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'closed';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)}m`;
  return `${h}h`;
}
function closeDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function gameTime(p) {
  return p.gameTime || p.expectedExpiration || p.closeTime || '';
}

export default function AIPredictions({ dataFolder, onActivity }) {
  const [markets, setMarkets] = useState([]);
  const [trades, setTrades] = useState([]);
  const [paperMode, setPaperMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [season, setSeason] = useState(dataFolder?.season || 1);
  const [week, setWeek] = useState('week1');
  const [tuning, setTuning] = useState(DEFAULTS);
  const [showDiag, setShowDiag] = useState(false);
  const [sliderIdx, setSliderIdx] = useState({});

  const root = dataFolder?.handle;

  useEffect(() => {
    if (!root) return;
    (async () => {
      const cached = await readCache(root);
      setMarkets(cached.markets);
      const s = await readSettings(root);
      setPaperMode(!!s.paperMode);
      setTrades(await readTrades(root, season, week));
    })().catch((e) => setError(e.message));
  }, [root, season, week]);

  const { predictions, cliffCount, midCount, diagnostics } = useMemo(
    () => computePredictions(markets, tuning),
    [markets, tuning]
  );

  useEffect(() => { setSliderIdx({}); }, [tuning]);

  function idxFor(p) {
    const override = sliderIdx[p.key];
    if (override == null) return p.targetIdx;
    return Math.max(0, Math.min(override, p.lines.length - 1));
  }
  function setIdx(p, idx) {
    setSliderIdx((prev) => ({ ...prev, [p.key]: Math.max(0, Math.min(idx, p.lines.length - 1)) }));
  }

  async function recordPrediction(p) {
    if (!paperMode) { setError('Paper mode must be ON to record predictions.'); return; }
    if (!root) { setError('Connect a data folder first.'); return; }
    const idx = idxFor(p);
    const chosen = p.lines[idx];
    if (!chosen) return;
    setBusy(true); setError('');
    try {
      const trade = {
        id: `${chosen.ticker}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        matchup: `${p.team} · ${p.event} · ${closeDate(p.closeTime)}`,
        market: `${p.team} over ${chosen.line} pts`,
        side: 'YES',
        price: Math.round(chosen.yesAsk * 100),
        probability: Math.round(chosen.yesAsk * 100),
        stake: 1,
        paper: true,
        status: 'open',
      };
      await appendTrade(root, season, week, trade);
      setTrades(await readTrades(root, season, week));
      const payout = chosen.yesAsk ? 1 / chosen.yesAsk : 0;
      onActivity?.('TRADE_RECORDED', `Prediction recorded · ${trade.market} · ${payout.toFixed(2)}x · ${p.strategy}`);
    } catch (e) {
      setError(e.message || 'Could not record prediction');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE</div>
          <h1>AI Predictions</h1>
          <p>Cliff strategy first; midpoint back-off fills the gaps. Yellow rows close outside the preferred window.</p>
        </div>
      </div>

      {!root && (
        <div className="notice">
          <div className="notice-icon"><BrainCircuit size={18} /></div>
          <div><b>Connect a data folder</b><span>Predictions are computed from the cached market scan.</span></div>
        </div>
      )}

      {error && <div className="notice error-notice"><b>{error}</b></div>}

      <div className="rec-filters">
        <div className="rec-filter-field">
          <label>Anchor (YES ≈)</label>
          <input type="number" min="0.30" max="0.70" step="0.01"
            value={tuning.anchorTarget}
            onChange={(e) => setTuning({ ...tuning, anchorTarget: Number(e.target.value) })}
            style={{ width: 70 }} />
        </div>
        <div className="rec-filter-field">
          <label>Strong ≥</label>
          <input type="number" min="0.10" max="0.40" step="0.01"
            value={tuning.strongDelta}
            onChange={(e) => setTuning({ ...tuning, strongDelta: Number(e.target.value) })}
            style={{ width: 70 }} />
        </div>
        <div className="rec-filter-field">
          <label>Cliff back-off</label>
          <input type="number" min="1" max="8" step="1"
            value={tuning.backOffSteps}
            onChange={(e) => setTuning({ ...tuning, backOffSteps: Number(e.target.value) })}
            style={{ width: 70 }} />
        </div>
        <div className="rec-filter-field">
          <label>Midpoint back-off</label>
          <input type="number" min="1" max="6" step="1"
            value={tuning.midBackOff}
            onChange={(e) => setTuning({ ...tuning, midBackOff: Number(e.target.value) })}
            style={{ width: 70 }} />
        </div>
        <div className="rec-filter-field">
          <label>Min ladder (≥6)</label>
          <input type="number" min="6" max="12" step="1"
            value={tuning.minMidLadder}
            onChange={(e) => setTuning({ ...tuning, minMidLadder: Math.max(6, Number(e.target.value)) })}
            style={{ width: 70 }} />
        </div>
        <div className="rec-filter-field">
          <label>Close window</label>
          <span style={{ fontSize: 11, color: '#8f9aab' }}>{tuning.maxHoursToClose}h</span>
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recommendations · {predictions.length}</h2>
            <p>{cliffCount} cliff · {midCount} midpoint · {predictions.filter((p) => !p.withinWindow).length} outside window</p>
          </div>
          <button className="text-btn" onClick={() => setShowDiag((v) => !v)}>
            {showDiag ? 'Hide' : 'Show'} diagnostics ({diagnostics.length})
          </button>
        </div>

        {predictions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><AlertCircle size={22} /></div>
            <b>No qualifying predictions</b>
            <span>No ladder produced a cliff or midpoint recommendation at the current tuning.</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CLOSES</th>
                  <th>STRAT</th>
                  <th>LEAGUE</th>
                  <th>TEAM</th>
                  <th>REFERENCE</th>
                  <th>JUMP</th>
                  <th style={{ minWidth: 220 }}>LINE</th>
                  <th>YES ASK</th>
                  <th>NO ASK</th>
                  <th>PAYOUT</th>
                  <th>FLAGS</th>
                  <th>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => {
                  const idx = idxFor(p);
                  const chosen = p.lines[idx];
                  const already = trades.some((t) => t.market === `${p.team} over ${chosen?.line} pts`);
                  const payout = chosen?.yesAsk ? 1 / chosen.yesAsk : null;
                  const isRecommended = idx === p.targetIdx;
                  const isCliff = p.strategy === 'cliff';
                  const refLine = isCliff ? p.strong : p.mid;
                  const refLabel = isCliff ? 'confidence' : 'midpoint';
                  const rowClass = p.flags.length > 0 ? 'row-warn' : (isCliff ? '' : 'row-mid');
                  return (
                    <tr key={p.key} className={rowClass}>
                      <td>
                        <b>{closesIn(gameTime(p))}</b>
                        <small style={{ display: 'block', marginTop: 2 }}>{closeDate(p.closeTime)}</small>
                      </td>
                      <td>
                        <span className={`status-pill ${isCliff ? 'strat-cliff' : 'strat-mid'}`}>
                          {isCliff ? 'cliff' : 'midpoint'}
                        </span>
                      </td>
                      <td><span className="status-pill">{p.league}</span></td>
                      <td>
                        <b>{p.team}</b>
                        {isRecommended && <small style={{ color: '#e5c77f' }}>recommended</small>}
                        {idx === p.midIdx && !isCliff && <small style={{ color: '#8f9aab' }}>midpoint</small>}
                        {idx === p.strongIdx && isCliff && <small style={{ color: '#8acb9d' }}>confidence</small>}
                        {idx === p.anchorIdx && <small style={{ color: '#8f9aab' }}>anchor ~50%</small>}
                      </td>
                      <td>
                        <small>{refLabel} {refLine?.line} · {cents(refLine?.yesAsk)}</small>
                      </td>
                      <td>
                        <b className="positive">
                          {isCliff ? `${Math.round(p.strongDelta * 100)}¢` : `−${p.midBackOff}`}
                        </b>
                      </td>
                      <td>
                        <div className="line-slider">
                          <input
                            type="range"
                            min={0}
                            max={p.lines.length - 1}
                            step={1}
                            value={idx}
                            onChange={(e) => setIdx(p, Number(e.target.value))}
                            title={`Line ${chosen?.line} · YES ${cents(chosen?.yesAsk)}`}
                          />
                          <span className="line-value">{chosen?.line ?? '—'}</span>
                        </div>
                        <small className="line-range">
                          {p.lines[0]?.line} – {p.lines[p.lines.length - 1]?.line}
                        </small>
                      </td>
                      <td>{cents(chosen?.yesAsk)}</td>
                      <td>{cents(chosen?.noAsk)}</td>
                      <td><b className="prob">{payout ? `${payout.toFixed(2)}×` : '—'}</b></td>
                      <td>
                        {p.flags.map((f) => (
                          <span key={f} className="status-pill flag-warn">{f}</span>
                        ))}
                      </td>
                      <td>
                        <button
                          className="secondary-btn"
                          disabled={busy || !root || !paperMode || already || !chosen}
                          onClick={() => recordPrediction(p)}
                        >
                          {already ? <><CheckCircle2 size={14} /> Done</> : 'Record'}
                        </button>
                        <a
                          className="icon-btn"
                          href={`https://kalshi.com/markets/${(p.event || chosen?.ticker || '').toLowerCase()}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open on Kalshi"
                          style={{ marginLeft: 6 }}
                        >
                          <ExternalLink size={14} />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-foot">
          <span>Source: cached Kalshi scan · cliff → midpoint fallback</span>
          <span>{predictions.length} rows</span>
        </div>
      </section>

      {showDiag && diagnostics.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div><h2>Diagnostics · {diagnostics.length}</h2><p>Ladders too short for either strategy.</p></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CLOSES</th>
                  <th>LEAGUE</th>
                  <th>TEAM</th>
                  <th>ANCHOR</th>
                  <th>LINE COUNT</th>
                  <th>STEP DELTAS</th>
                  <th>REASON</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.map((d, i) => {
                  const anchor = d.anchorIdx != null ? d.lines[d.anchorIdx] : null;
                  return (
                    <tr key={`${d.key}-${i}`}>
                      <td><small>{closesIn(d.gameTime || d.expectedExpiration || d.closeTime)}</small></td>
                      <td><span className="status-pill">{d.league}</span></td>
                      <td><b>{d.team}</b></td>
                      <td><small>{anchor ? `${anchor.line} · ${cents(anchor.yesAsk)}` : '—'}</small></td>
                      <td><small>{d.lines.length}</small></td>
                      <td><small>{d.steps.map((s) => `${Math.round(s.delta * 100)}¢`).join(' · ')}</small></td>
                      <td><small>{d.reason}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}