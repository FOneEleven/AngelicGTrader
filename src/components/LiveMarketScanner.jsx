import React, { useEffect, useMemo, useState } from 'react';
import { Radar, RefreshCw, ExternalLink, Search, Trash2 } from 'lucide-react';
import { fetchSportsMarkets } from '../lib/kalshi';
import {
  readCache, isCacheFresh, appendCacheBatch, clearCache, listCacheBatches,
} from '../lib/marketCache';

const LEAGUES = [
  { key: 'ALL', label: 'All' },
  { key: 'NFL', label: 'NFL' },
  { key: 'NBA', label: 'NBA' },
  { key: 'MLB', label: 'MLB' },
  { key: 'NHL', label: 'NHL' },
  { key: 'NCAAMB', label: 'NCAAMB' },
  { key: 'NCAAF', label: 'NCAAF' },
  { key: 'ESOCCER', label: 'Soccer' },
  { key: 'UFC', label: 'UFC' },
];

function leagueOf(ticker = '') {
  const m = ticker.match(/^KX([A-Z0-9]+?)(?:GAME|SPREAD|TOTAL|TEAMTOTAL|WINMARGIN|1H|1Q|TD|RSHYDS|RACE|MOST)/);
  return m ? m[1] : 'OTHER';
}
function cents(v) { return v == null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}¢`; }
function compact(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
}
// Prefer expected expiration; fall back to closeTime.
function gameTime(m) {
  return m.expectedExpiration || m.closeTime || '';
}
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
function fmtBatch(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function LiveMarketScanner({ dataFolder, onActivity }) {
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState('openInterest');
  const [league, setLeague] = useState('ALL');
  const [query, setQuery] = useState('');
  const [minOI, setMinOI] = useState(0);
  const [batches, setBatches] = useState([]);
  const [batch, setBatch] = useState('LATEST');
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const root = dataFolder?.handle;

  async function loadFromCache() {
    if (!root) return false;
    const { markets: cached, fetchedAt } = await readCache(root);
    if (!cached.length) return false;
    const batchList = await listCacheBatches(root);
    setBatches(batchList);
    setLastFetchedAt(fetchedAt);
    setMarkets(cached);
    return true;
  }

  async function fetchFresh() {
    setLoading(true); setError('');
    try {
      const list = await fetchSportsMarkets();
      if (root && list.length) {
        const at = await appendCacheBatch(root, list);
        setLastFetchedAt(at);
        await loadFromCache();
      } else {
        setMarkets(list);
      }
      onActivity?.('SCANNER_RUN', `Scanner pulled ${list.length} sports markets`);
    } catch (e) {
      setError(e.message || 'Failed to fetch Kalshi markets');
    } finally {
      setLoading(false);
    }
  }

  async function ensureData({ force = false } = {}) {
    if (!root) { await fetchFresh(); return; }
    if (!force) {
      const fresh = await isCacheFresh(root);
      const had = await loadFromCache();
      if (fresh && had) return;
    }
    await fetchFresh();
  }

  useEffect(() => { ensureData(); }, [root]);

  async function handleRefresh() { await ensureData({ force: true }); }

  async function handleClearCache() {
    if (!root) return;
    await clearCache(root);
    setMarkets([]); setBatches([]); setLastFetchedAt(null); setBatch('LATEST');
    onActivity?.('SCANNER_CACHE_CLEARED', 'Market cache cleared');
  }

  const batchMarkets = useMemo(() => {
    if (batch === 'LATEST' || !batch) return markets;
    return markets.filter((m) => m.fetchedAt === batch);
  }, [markets, batch]);

  const rows = useMemo(() => {
    let out = batchMarkets;
    if (league !== 'ALL') out = out.filter((m) => leagueOf(m.ticker) === league);
    if (minOI > 0) out = out.filter((m) => m.openInterest >= minOI);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((m) =>
        m.title.toLowerCase().includes(q) ||
        m.ticker.toLowerCase().includes(q) ||
        (m.subtitle || '').toLowerCase().includes(q)
      );
    }
    return [...out].sort((a, b) => {
      if (sortBy === 'closeTime') {
        const at = gameTime(a) ? new Date(gameTime(a)).getTime() : Infinity;
        const bt = gameTime(b) ? new Date(gameTime(b)).getTime() : Infinity;
        return at - bt;
      }
      return (b[sortBy] || 0) - (a[sortBy] || 0);
    });
  }, [batchMarkets, league, query, minOI, sortBy]);

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE</div>
          <h1>Live Market Scanner</h1>
          <p>Upcoming sports markets from Kalshi. Cached locally per fetch.</p>
        </div>
        <div className="scanner-heading-actions">
          {root && (
            <button className="secondary-btn" onClick={handleClearCache} title="Clear cached markets">
              <Trash2 size={15} /> Clear cache
            </button>
          )}
          <button className="secondary-btn" onClick={handleRefresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> {loading ? 'Pulling…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!root && (
        <div className="notice">
          <div className="notice-icon"><Radar size={18} /></div>
          <div><b>No data folder connected</b><span>Markets are held in memory only. Connect a folder to persist them.</span></div>
        </div>
      )}

      {root && lastFetchedAt && (
        <div className="scanner-meta">
          Cache last updated: <b>{fmtBatch(lastFetchedAt)}</b> · {batches.length} batch{batches.length === 1 ? '' : 'es'} on disk
        </div>
      )}

      {error && (
        <div className="notice error-notice">
          <div className="notice-icon"><Radar size={18} /></div>
          <div><b>Kalshi request failed</b><span>{error}</span></div>
        </div>
      )}

      {!error && (
        <>
          <div className="scanner-toolbar">
            <div className="scanner-filters">
              <div className="sidebar-search scanner-search">
                <Search size={14}/>
                <input placeholder="Search market or ticker…" value={query} onChange={(e) => setQuery(e.target.value)}/>
              </div>
              <select className="scanner-select" value={league} onChange={(e) => setLeague(e.target.value)}>
                {LEAGUES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
              <select className="scanner-select" value={minOI} onChange={(e) => setMinOI(Number(e.target.value))}>
                <option value={0}>Any OI</option>
                <option value={100}>OI ≥ 100</option>
                <option value={500}>OI ≥ 500</option>
                <option value={1000}>OI ≥ 1K</option>
              </select>
              {batches.length > 0 && (
                <select className="scanner-select" value={batch} onChange={(e) => setBatch(e.target.value)}>
                  <option value="LATEST">Latest batch</option>
                  {batches.map((b) => <option key={b} value={b}>{fmtBatch(b)}</option>)}
                </select>
              )}
            </div>
            <div className="segmented">
              <button className={`seg-btn ${sortBy === 'openInterest' ? 'active' : ''}`} onClick={() => setSortBy('openInterest')}>Open interest</button>
              <button className={`seg-btn ${sortBy === 'volume24h' ? 'active' : ''}`} onClick={() => setSortBy('volume24h')}>24h volume</button>
              <button className={`seg-btn ${sortBy === 'closeTime' ? 'active' : ''}`} onClick={() => setSortBy('closeTime')}>Closing soon</button>
            </div>
          </div>
          <div className="scanner-count">{batchMarkets.length} in batch · {rows.length} shown</div>
        </>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div><h2>Sports markets</h2><p>Kalshi public market data</p></div>
        </div>

        {loading && markets.length === 0 && <div className="empty-state"><span>Pulling markets…</span></div>}

        {!loading && !error && rows.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><Radar size={22} /></div>
            <b>No markets match</b>
            <span>Try widening the filters or fetch a fresh batch.</span>
          </div>
        )}

        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>MARKET</th>
                  <th>LEAGUE</th>
                  <th>YES BID</th>
                  <th>YES ASK</th>
                  <th>OPEN INTEREST</th>
                  <th>24H VOL</th>
                  <th>CLOSES</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const lg = leagueOf(m.ticker);
                  return (
                    <tr key={`${m.fetchedAt}-${m.ticker}`}>
                      <td>
                        <div className="match-sport">
                          <span className={`sport-badge ${lg.startsWith('NBA') ? 'green' : lg.startsWith('NFL') ? 'blue' : 'orange'}`}>
                            {lg.slice(0, 4)}
                          </span>
                          <div>
                            <b>{m.title}</b>
                            <small>{m.eventTicker || m.ticker}</small>
                          </div>
                        </div>
                      </td>
                      <td><span className="status-pill">{lg}</span></td>
                      <td>{cents(m.yesBid)}</td>
                      <td>{cents(m.yesAsk)}</td>
                      <td><b className="prob">{compact(m.openInterest)}</b></td>
                      <td>{compact(m.volume24h)}</td>
                      <td>{closesIn(gameTime(m))}</td>
                      <td>
                        <a
                          className="icon-btn"
                          href={`https://kalshi.com/markets/${(m.eventTicker || m.ticker).toLowerCase()}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open on Kalshi"
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
          <span>Source: Kalshi Trade API v2 via Azure proxy</span>
          <span>{rows.length} rows</span>
        </div>
      </section>
    </div>
  );
}