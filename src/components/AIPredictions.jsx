import React, { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, ExternalLink, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { readCache } from '../lib/marketCache';
import { readSettings, appendTrade, readTrades } from '../lib/dataModel';
import { computePredictions } from '../lib/predictions';
import { fetchTeamStatistics } from '../lib/sportsStats';
import { analyzeMarket } from '../lib/analyzeMarket';
import { teamStatsCacheKey, getCachedTeamStats, setCachedTeamStats } from '../lib/teamStatsCache';
import { getCachedAnalysis, setCachedAnalysis } from '../lib/analysisCache';

const TEAM_TOTAL = /^KX([A-Z0-9]+?)TEAMTOTAL-/;

function cents(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v) * 100) + '¢'; }
function closesIn(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'closed';
  const h = Math.floor(ms / 3600000);
  return h < 1 ? Math.floor(ms / 60000) + 'm' : h + 'h';
}
function closeDate(iso) {
  return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
function marketTeamName(m) {
  const text = m.subtitle || m.title || '';
  const match = text.match(/^(.+?)\s+over\s+[\d.]+/i);
  return match ? match[1].trim() : text.trim();
}
function leagueFor(p) {
  const match = String(p.league || '').match(/^(NFL|NBA)$/i);
  return match ? match[1].toUpperCase() : null;
}
function eventOpponent(markets, event, team) {
  const names = [...new Set(markets.filter((m) => TEAM_TOTAL.test(m.ticker || '') && (m.eventTicker || m.ticker) === event).map(marketTeamName).filter(Boolean))];
  return names.find((name) => name.toLowerCase() !== String(team).toLowerCase()) || '';
}
function normalizeStats(raw, teamName, opponentName) {
  const team = raw?.team || {};
  const opponent = raw?.opponent || null;
  const inputs = raw?.modelInputs || {};
  return {
    team: {
      ...team, name: team.name || teamName,
      pointsPerGame: inputs.teamPointsPerGame ?? team.pointsPerGame ?? null,
      recent5PPG: team.recent5PPG ?? inputs.recentTeamPPG ?? null,
      recent10PPG: team.recent10PPG ?? null,
      pointsAllowedPerGame: inputs.teamPointsAllowedPerGame ?? team.pointsAllowedPerGame ?? null,
    },
    opponent: opponent ? {
      ...opponent, name: opponent.name || opponentName,
      pointsAllowedPerGame: inputs.opponentPointsAllowedPerGame ?? opponent.pointsAllowedPerGame ?? null,
      recent5PointsAllowed: opponent.recent5PointsAllowed ?? inputs.opponentRecentPointsAllowed ?? null,
    } : null,
    modelInputs: inputs, recentGames: raw?.recentGames || [],
    dataQuality: raw?.dataQuality || {}, provider: raw?.provider || 'ESPN',
    league: raw?.league, season: raw?.season, seasonType: raw?.seasonType,
    fetchedAt: raw?.fetchedAt || raw?.retrievedAt || new Date().toISOString(),
  };
}
function probabilityFor(analysis, side) {
  const yes = Number(analysis?.prediction?.probabilityYes);
  if (!Number.isFinite(yes)) return null;
  return side === 'NO' ? 1 - yes : yes;
}
function askFor(line, side) {
  const v = side === 'NO' ? line?.noAsk : line?.yesAsk;
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}
function recommendedIndex(p) {
  const ticker = p.recommended?.ticker;
  const index = p.lines.findIndex((line) => line.ticker === ticker);
  if (index >= 0) return index;
  return Math.max(0, Math.min(Number(p.targetIdx) || 0, p.lines.length - 1));
}
function analysisKey(market, stats) {
  return JSON.stringify({
    ticker: market.ticker, line: market.line, yesAsk: market.yesAsk, noAsk: market.noAsk,
    statsFetchedAt: stats.fetchedAt, teamId: stats.team?.id, opponentId: stats.opponent?.id,
  });
}

export default function AIPredictions({ dataFolder, onActivity }) {
  const [markets, setMarkets] = useState([]);
  const [trades, setTrades] = useState([]);
  const [paperMode, setPaperMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [season, setSeason] = useState(dataFolder?.season || 1);
  const [week, setWeek] = useState('week1');
  const [analyses, setAnalyses] = useState({});
  const [statsByKey, setStatsByKey] = useState({});
  const [analysisErrors, setAnalysisErrors] = useState({});
  const [sideByKey, setSideByKey] = useState({});
  const [sliderIdx, setSliderIdx] = useState({});
  const root = dataFolder?.handle;

  useEffect(() => {
    if (!root) return;
    (async () => {
      const cached = await readCache(root);
      setMarkets(cached.markets);
      const settings = await readSettings(root);
      setPaperMode(!!settings.paperMode);
      setTrades(await readTrades(root, season, week));
    })().catch((e) => setError(e.message));
  }, [root, season, week]);

  const { predictions } = useMemo(() => computePredictions(markets), [markets]);

  useEffect(() => {
    if (!root || !markets.length || !predictions.length) return;
    let cancelled = false;
    async function run() {
      setBusy(true); setError(''); setProgress('Resolving ESPN team statistics…');
      const nextStats = {}, nextAnalyses = {}, nextErrors = {};
      const statsForPrediction = new Map();
      try {
        const currentSeason = new Date().getFullYear();
        for (const p of predictions) {
          if (cancelled) return;
          const league = leagueFor(p);
          const opponent = eventOpponent(markets, p.event, p.team);
          if (!league || !opponent) {
            nextErrors[p.key] = !league ? 'Unsupported league for ESPN statistics.' : 'Could not identify the opponent in this event.';
            continue;
          }
          const params = { league, team: p.team, opponent, season: currentSeason, seasonType: '2' };
          const key = teamStatsCacheKey(params);
          let entry = await getCachedTeamStats(root, key);
          if (!entry) {
            setProgress('Fetching ESPN: ' + p.team + ' vs ' + opponent);
            const raw = await fetchTeamStatistics(params);
            entry = await setCachedTeamStats(root, key, normalizeStats(raw, p.team, opponent));
          }
          const stats = entry.data;
          if (!stats?.team || stats.team.pointsPerGame == null || stats.opponent?.pointsAllowedPerGame == null) {
            nextErrors[p.key] = 'ESPN response is missing team PPG or opponent PA.';
            continue;
          }
          nextStats[p.key] = stats;
          statsForPrediction.set(p.key, stats);
        }

        const tasks = [];
        for (const p of predictions) {
          const stats = statsForPrediction.get(p.key);
          // Each AI Predictions entry starts with exactly the line selected by
          // its existing Midpoint/Cliff population logic. Other ladder lines
          // are analyzed only if the user explicitly selects one in this box.
          if (stats && p.recommended) tasks.push({ p, line: p.recommended, stats });
        }
        let completed = 0;
        for (let offset = 0; offset < tasks.length; offset += 3) {
          if (cancelled) return;
          const batch = tasks.slice(offset, offset + 3);
          const results = await Promise.all(batch.map(async ({ p, line, stats }) => {
            const market = {
              ticker: line.ticker, title: p.team + ' over ' + line.line + ' points',
              league: leagueFor(p), team: p.team, opponent: stats.opponent?.name || '',
              line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk,
              closeTime: p.closeTime || p.expectedExpiration || null,
            };
            const cacheKey = analysisKey(market, stats);
            const cached = await getCachedAnalysis(root, cacheKey);
            if (cached) return { ticker: line.ticker, data: cached.data };
            const data = await analyzeMarket({
              market,
              teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
              opponentStats: stats.opponent,
              context: { source: 'ESPN', season: stats.season, seasonType: stats.seasonType, statisticsFetchedAt: stats.fetchedAt },
            });
            return { ticker: line.ticker, data, cacheKey };
          }));
          for (const result of results) {
            if (result.cacheKey) await setCachedAnalysis(root, result.cacheKey, result.data);
            nextAnalyses[result.ticker] = result.data;
            completed += 1;
          }
          if (!cancelled) setProgress('OpenAI analysis: ' + completed + ' / ' + tasks.length + ' AI Prediction entries');
        }
        if (cancelled) return;
        setStatsByKey(nextStats); setAnalyses(nextAnalyses); setAnalysisErrors(nextErrors); setProgress('');
      } catch (e) {
        if (!cancelled) {
          setStatsByKey(nextStats); setAnalyses(nextAnalyses); setAnalysisErrors(nextErrors);
          setError(e.message || 'Prediction analysis failed'); setProgress('');
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [root, markets, predictions]);

  function sideFor(p) { return sideByKey[p.key] || 'YES'; }
  function idxFor(p) {
    if (sliderIdx[p.key] != null) return Math.max(0, Math.min(sliderIdx[p.key], p.lines.length - 1));
    return recommendedIndex(p);
  }

  async function analyzeSelectedLine(p, line) {
    const stats = statsByKey[p.key];
    if (!root || !stats || !line || analyses[line.ticker]) return;
    setBusy(true);
    setProgress('Analyzing selected line: ' + p.team + ' over ' + line.line);
    setAnalysisErrors((old) => ({ ...old, [p.key]: '' }));
    try {
      const market = {
        ticker: line.ticker, title: p.team + ' over ' + line.line + ' points',
        league: leagueFor(p), team: p.team, opponent: stats.opponent?.name || '',
        line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk,
        closeTime: p.closeTime || p.expectedExpiration || null,
      };
      const cacheKey = analysisKey(market, stats);
      const cached = await getCachedAnalysis(root, cacheKey);
      const data = cached?.data || await analyzeMarket({
        market,
        teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
        opponentStats: stats.opponent,
        context: { source: 'ESPN', season: stats.season, seasonType: stats.seasonType, statisticsFetchedAt: stats.fetchedAt },
      });
      if (!cached) await setCachedAnalysis(root, cacheKey, data);
      setAnalyses((old) => ({ ...old, [line.ticker]: data }));
    } catch (e) {
      setAnalysisErrors((old) => ({ ...old, [p.key]: e.message || 'Selected-line analysis failed' }));
    } finally {
      setBusy(false);
      setProgress('');
    }
  }
  function setSide(p, side) {
    setSideByKey((old) => ({ ...old, [p.key]: side }));
    setSliderIdx((old) => { const next = { ...old }; delete next[p.key]; return next; });
  }
  async function recordPrediction(p) {
    if (!paperMode) { setError('Paper mode must be ON to record predictions.'); return; }
    if (!root) { setError('Connect a data folder first.'); return; }
    const line = p.lines[idxFor(p)], side = sideFor(p), analysis = analyses[line?.ticker];
    const probability = probabilityFor(analysis, side), ask = askFor(line, side);
    if (probability == null || ask == null) { setError('OpenAI analysis or executable ask is missing for this line.'); return; }
    if (trades.some((t) => t.ticker === line.ticker && t.side === side)) return;
    setBusy(true); setError('');
    try {
      const stats = statsByKey[p.key] || {}, ai = analysis.prediction || {};
      const trade = {
        id: line.ticker + '-' + side + '-' + Date.now(), timestamp: new Date().toISOString(),
        matchup: p.team + ' vs ' + (stats.opponent?.name || 'opponent') + ' · ' + closeDate(p.closeTime),
        market: p.team + ' over ' + line.line + ' pts', side,
        price: Math.round(ask * 100), probability: Math.round(probability * 100),
        strategy: null, ticker: line.ticker, line: line.line, marketProbability: ask,
        modelProbability: probability, edge: probability - ask, modelVersion: analysis.model || 'OpenAI',
        context: { team: stats.team, opponent: stats.opponent, modelInputs: stats.modelInputs, dataQuality: stats.dataQuality },
        reasoning: (ai.reasoning || []).join(' '), stake: 1, paper: true, status: 'open',
      };
      await appendTrade(root, season, week, trade);
      setTrades(await readTrades(root, season, week));
      onActivity?.('PREDICTION_RECORDED', side + ' ' + trade.market + ' · ' + Math.round(probability * 100) + '% · ' + cents(ask) + ' ask');
    } catch (e) { setError(e.message || 'Could not record prediction'); }
    finally { setBusy(false); }
  }

  return (
    <div className="page-shell">
      <div className="page-heading">
        <div><div className="eyebrow">WORKSPACE</div><h1>AI Predictions</h1><p>Existing market entries enriched with cached ESPN statistics and OpenAI probability analysis.</p></div>
        <div className="status-pill">{busy ? 'Analyzing markets' : 'Analysis ready'}</div>
      </div>
      {!root && <div className="notice"><div className="notice-icon"><BrainCircuit size={18}/></div><div><b>Connect a data folder</b><span>ESPN and OpenAI results are cached in its meta folder.</span></div></div>}
      {error && <div className="notice error-notice"><b>{error}</b></div>}
      {progress && <div className="notice"><RefreshCw size={16}/><b>{progress}</b></div>}
      <section className="panel">
        <div className="panel-heading"><div><h2>AI prediction entries · {predictions.length}</h2><p>One strategy-selected market line analyzed per entry; alternate lines are analyzed only when selected here.</p></div></div>
        {!predictions.length ? (
          <div className="empty-state"><div className="empty-icon"><AlertCircle size={22}/></div><b>No team-total market entries</b><span>Run Live Market Scanner to populate the existing market cache.</span></div>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>CLOSES</th><th>LEAGUE</th><th>TEAM / EVENT</th><th>LINE</th><th>SIDE</th><th>ASK</th><th>MODEL PROB.</th><th>EDGE</th><th>PAYOUT</th><th>AI</th><th>ACTION</th></tr></thead>
            <tbody>{predictions.map((p) => {
              const idx = idxFor(p), chosen = p.lines[idx], side = sideFor(p);
              const analysis = analyses[chosen?.ticker], probability = probabilityFor(analysis, side), ask = askFor(chosen, side);
              const edge = probability == null || ask == null ? null : probability - ask;
              const payout = ask > 0 ? 1 / ask : null;
              const already = trades.some((t) => t.ticker === chosen?.ticker && t.side === side);
              const rowError = analysisErrors[p.key];
              return <tr key={p.key}>
                <td><b>{closesIn(p.gameTime || p.expectedExpiration || p.closeTime)}</b><small style={{display:'block',marginTop:2}}>{closeDate(p.closeTime)}</small></td>
                <td><span className="status-pill">{p.league}</span></td>
                <td><b>{p.team}</b><small style={{display:'block',marginTop:3}}>{p.event}</small>{rowError && <small className="negative">{rowError}</small>}</td>
                <td><div className="line-slider"><input type="range" disabled={busy} min="0" max={Math.max(0,p.lines.length-1)} step="1" value={idx} onChange={(e)=>{const next=Number(e.target.value);setSliderIdx((old)=>({...old,[p.key]:next}));analyzeSelectedLine(p,p.lines[next]);}}/><span className="line-value">{chosen?.line ?? '—'}</span></div><small className="line-range">{p.lines[0]?.line} – {p.lines[p.lines.length-1]?.line}</small></td>
                <td><select value={side} onChange={(e)=>setSide(p,e.target.value)} aria-label={p.team + ' position side'}><option value="YES">YES</option><option value="NO">NO</option></select></td>
                <td>{cents(ask)}</td>
                <td><b className="prob">{probability == null ? '—' : Math.round(probability*100) + '%'}</b><small style={{display:'block'}}>{probability == null ? 'Awaiting analysis' : 'Selected line'}</small></td>
                <td>{edge == null ? '—' : (edge >= 0 ? '+' : '') + Math.round(edge*100) + '¢'}</td>
                <td><b className="prob">{payout ? payout.toFixed(2) + '×' : '—'}</b></td>
                <td>{analysis ? <span className="status-pill strat-cliff">Ready</span> : <span className="status-pill">Pending</span>}</td>
                <td><button className="secondary-btn" disabled={busy || !root || !paperMode || already || probability == null || ask == null} onClick={()=>recordPrediction(p)}>{already ? <><CheckCircle2 size={14}/> Done</> : 'Record'}</button><a className="icon-btn" href={'https://kalshi.com/markets/' + (p.event || chosen?.ticker || '').toLowerCase()} target="_blank" rel="noreferrer" title="Open on Kalshi" style={{marginLeft:6}}><ExternalLink size={14}/></a></td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
        <div className="table-foot"><span>OpenAI evaluates the selected line in each AI Prediction entry. Team PPG and opponent PA remain internal.</span><span>{predictions.length} entries</span></div>
      </section>
    </div>
  );
}
