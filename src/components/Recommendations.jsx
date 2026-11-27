import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, ExternalLink, CheckCircle2 } from 'lucide-react';
import { readSettings, writeSettings, appendTrade, readTrades } from '../lib/dataModel';
import { readCache } from '../lib/marketCache';

const TEAM_TOTAL = /^KX([A-Z0-9]+?)TEAMTOTAL-/;

function leagueOf(ticker = '') {
  const m = ticker.match(TEAM_TOTAL);
  return m ? m[1] : null;
}
function parseLine(subtitle = '') {
  const m = subtitle.match(/over\s+([\d.]+)/i);
  return m ? Number(m[1]) : null;
}
function teamName(subtitle = '') {
  const m = subtitle.match(/^(.+?)\s+over\s+/i);
  return m ? m[1].trim() : subtitle;
}
function gameTime(m) {
  return m.expectedExpiration || m.closeTime || '';
}
function cents(v) { return v == null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}¢`; }
function closesIn(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'closed';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function closeDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Recommendations({ dataFolder, onActivity }) {
  const [paperMode, setPaperMode] = useState(true);
  const [season, setSeason] = useState(dataFolder?.season || 1);
  const [week, setWeek] = useState('week1');
  const [markets, setMarkets] = useState([]);
  const [trades, setTrades] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [batch, setBatch] = useState('LATEST');
  const [lineIndex, setLineIndex] = useState({});

  const root = dataFolder?.handle;

  useEffect(() => {
    if (!root) return;
    (async () => {
      const s = await readSettings(root);
      setPaperMode(!!s.paperMode);
      const cached = await readCache(root);
      setMarkets(cached.markets);
      setTrades(await readTrades(root, season, week));
    })().catch((e) => setError(e.message));
  }, [root, season, week]);

  const teams = useMemo(() => {
    const scoped = batch === 'LATEST'
      ? markets
      : markets.filter((m) => m.fetchedAt === batch);

    const buckets = new Map();
    for (const m of scoped) {
      if (!TEAM_TOTAL.test(m.ticker)) continue;
      const line = parseLine(m.subtitle || m.title);
      if (line == null) continue;
      const team = teamName(m.subtitle || m.title);
      const event = m.eventTicker || m.ticker;
      const gt = gameTime(m);
      const key = `${event}::${team}::${gt}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key, event,
          league: leagueOf(m.ticker),
          team,
          closeTime: m.closeTime || '',
          expectedExpiration: m.expectedExpiration || '',
          gameTime: gt,
          openInterest: m.openInterest,
          lines: [],
        });
      }
      const entry = buckets.get(key);
      entry.lines.push({
        ticker: m.ticker,
        line,
        yesAsk: m.yesAsk,
        yesBid: m.yesBid,
        noAsk: m.noAsk ?? (m.yesAsk == null ? null : 1 - m.yesBid),
        noBid: m.noBid ?? (m.yesBid == null ? null : 1 - m.yesAsk),
        openInterest: m.openInterest,
        closeTime: m.closeTime || '',
        expectedExpiration: m.expectedExpiration || '',
      });
      if (m.openInterest > entry.openInterest) entry.openInterest = m.openInterest;
    }

    return [...buckets.values()]
      .map((e) => ({ ...e, lines: e.lines.sort((a, b) => a.line - b.line) }))
      .sort((a, b) => {
        const at = a.gameTime ? new Date(a.gameTime).getTime() : Infinity;
        const bt = b.gameTime ? new Date(b.gameTime).getTime() : Infinity;
        return at - bt;
      });
  }, [markets, batch]);

  function chosenIndex(entry) {
    const raw = lineIndex[entry.key];
    if (raw == null) return Math.floor(entry.lines.length / 2);
    return Math.min(raw, entry.lines.length - 1);
  }
  function setChosen(entry, idx) {
    setLineIndex((prev) => ({ ...prev, [entry.key]: Math.min(idx, entry.lines.length - 1) }));
  }
  async function togglePaper(next) {
    setPaperMode(next);
    if (root) await writeSettings(root, { paperMode: next });
  }
  async function recordTrade(entry) {
    if (!paperMode) { setError('Paper mode must be ON to record recommendations.'); return; }
    if (!root) { setError('Connect a data folder first.'); return; }
    const idx = chosenIndex(entry);
    const line = entry.lines[idx];
    if (!line) return;
    setBusy(true); setError('');
    try {
      const trade = {
        id: `${line.ticker}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        matchup: `${entry.team} · ${entry.event} · ${closeDate(entry.closeTime)}`,
        market: `${entry.team} over ${line.line} pts`,
        side: 'YES',
        price: Math.round((line.yesAsk || 0) * 100),
        probability: Math.round((line.yesAsk || 0) * 100),
        stake: 1,
        paper: true,
        status: 'open',
      };
      await appendTrade(root, season, week, trade);
      setTrades(await readTrades(root, season, week));
      onActivity?.('TRADE_RECORDED', `Trade recorded · ${trade.market} · paper`);
    } catch (e) {
      setError(e.message || 'Could not record trade');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE</div>
          <h1>Betting Recommendations</h1>
          <p>One row per team per expected resolution time. Use each row's slider to pick a line.</p>
        </div>
      </div>

      {!root && (
        <div className="notice">
          <div className="notice-icon"><ClipboardList size={18} /></div>
          <div><b>Connect a data folder</b><span>Recommendations read from the local market cache.</span></div>
        </div>
      )}

      {error && <div className="notice error-notice"><b>{error}</b></div>}

      <div className="rec-filters">
        <div className="rec-filter-field">
          <label>Batch</label>
          <select className="scanner-select" value={batch} onChange={(e) => setBatch(e.target.value)}>
            <option value="LATEST">Latest cache</option>
            {[...new Set(markets.map((m) => m.fetchedAt))].sort().reverse().map((b) => (
              <option key={b} value={b}>{new Date(b).toLocaleString()}</option>
            ))}
          </select>
        </div>
        <div className="rec-filter-field">
          <label>Paper mode</label>
          <button className={`paper-toggle ${paperMode ? 'on' : 'off'}`} onClick={() => togglePaper(!paperMode)}>
            {paperMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Team totals · {teams.length} entries</h2>
            <p>Sorted by expected resolution. Slide to pick a line per entry.</p>
          </div>
        </div>

        {teams.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><ClipboardList size={22} /></div>
            <b>No team-total markets cached</b>
            <span>Run the Live Market Scanner once to populate the cache.</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CLOSES</th>
                  <th>LEAGUE</th>
                  <th>TEAM</th>
                  <th style={{ minWidth: 220 }}>LINE</th>
                  <th>YES ASK</th>
                  <th>NO ASK</th>
                  <th>OI</th>
                  <th>EVENT</th>
                  <th>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((entry) => {
                  const idx = chosenIndex(entry);
                  const line = entry.lines[idx];
                  const already = trades.some((t) => t.market === `${entry.team} over ${line?.line} pts`);
                  return (
                    <tr key={entry.key}>
                      <td>
                        <b>{closesIn(entry.gameTime)}</b>
                        <small style={{ display: 'block', marginTop: 2 }}>{closeDate(entry.closeTime)}</small>
                      </td>
                      <td><span className="status-pill">{entry.league}</span></td>
                      <td><b>{entry.team}</b></td>
                      <td>
                        <div className="line-slider">
                          <input
                            type="range"
                            min={0}
                            max={entry.lines.length - 1}
                            step={1}
                            value={idx}
                            onChange={(e) => setChosen(entry, Number(e.target.value))}
                            title={`Line ${line?.line} · YES ${cents(line?.yesAsk)}`}
                          />
                          <span className="line-value">{line?.line ?? '—'}</span>
                        </div>
                        <small className="line-range">
                          {entry.lines[0]?.line} – {entry.lines[entry.lines.length - 1]?.line}
                        </small>
                      </td>
                      <td>{cents(line?.yesAsk)}</td>
                      <td>{cents(line?.noAsk)}</td>
                      <td>{Math.round(entry.openInterest).toLocaleString()}</td>
                      <td><small>{entry.event}</small></td>
                      <td>
                        <button
                          className="secondary-btn"
                          disabled={busy || !root || !paperMode || already || !line}
                          onClick={() => recordTrade(entry)}
                        >
                          {already ? <><CheckCircle2 size={14} /> Done</> : 'Record'}
                        </button>
                        <a
                          className="icon-btn"
                          href={`https://kalshi.com/markets/${(entry.event || line?.ticker || '').toLowerCase()}`}
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
          <span>Source: cached Kalshi scan · team-total markets only</span>
          <span>{teams.length} entries</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><h2>Recorded trades · season {season}/{week}</h2></div></div>
        {trades.length === 0 ? (
          <div className="empty-state"><b>No trades recorded yet</b><span>Record a recommendation above to see it here.</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>TIME</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>PRICE</th><th>PAPER</th><th>STATUS</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.timestamp).toLocaleTimeString()}</td>
                    <td>{t.matchup}</td>
                    <td>{t.market}</td>
                    <td>{t.side}</td>
                    <td>{t.price}¢</td>
                    <td><span className={`status-pill ${t.paper ? 'paper' : 'live'}`}>{t.paper ? 'Paper' : 'Live'}</span></td>
                    <td>{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}