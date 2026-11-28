import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, ExternalLink, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { readCache } from '../lib/marketCache';
import { readSettings, appendTrade, readTrades, readAIPredictionSelections, deleteTrade, latestSeason, listSeasonProfiles, updateSeasonProfile, readSeasonTrades, confirmedWalletReturns, appendQualifiedCandidate } from '../lib/dataModel';
import { computePredictions } from '../lib/predictions';
import { fetchTeamStatistics } from '../lib/sportsStats';
import { fetchMLBTeamStatistics } from '../lib/mlbStats';
import { analyzeMarket } from '../lib/analyzeMarket';
import { teamStatsCacheKey, getCachedTeamStats, setCachedTeamStats } from '../lib/teamStatsCache';
import { getCachedAnalysis, setCachedAnalysis } from '../lib/analysisCache';
import { finalInterrogateCandidate } from '../lib/finalInterrogation';

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
  const text = (m.subtitle || m.title || '').replace(/^Will\s+(?:the\s+)?/i, '').replace(/\s+score\s+over\s+/i, ' over ');
  const match = text.match(/^(.+?)\s+over\s+[\d.]+/i);
  return match ? match[1].trim() : text.trim();
}
function leagueFor(p) {
  const match = String(p.league || '').match(/^(NFL|NBA|MLB)$/i);
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
function scanLineIndices(lines, side, league) {
  const indices = lines.map((_, index) => index);
  if (side === 'NO') indices.reverse();
  if (league !== 'NBA' || !indices.length) return indices;
  const selected = [indices[0]];
  let lastLine = Number(lines[indices[0]]?.line);
  for (const index of indices.slice(1)) {
    const currentLine = Number(lines[index]?.line);
    if (Number.isFinite(currentLine) && Number.isFinite(lastLine) && Math.abs(currentLine - lastLine) >= 4) {
      selected.push(index);
      lastLine = currentLine;
    }
  }
  return selected;
}

function recommendedIndex(p) {
  const ticker = p.recommended?.ticker;
  const index = p.lines.findIndex((line) => line.ticker === ticker);
  if (index >= 0) return index;
  return Math.max(0, Math.min(Number(p.targetIdx) || 0, p.lines.length - 1));
}
function activeWorthCondition(profile, currentWorthValue) {
  const original = Math.max(0, Number(profile?.quotaValue ?? profile?.initialBalance ?? profile?.balance) || 0);
  const currentWorth = Math.max(0, Number(currentWorthValue) || 0);
  const ratio = original > 0 ? currentWorth / original : 0;
  return ratio >= 3 ? '3x' : ratio >= 2 ? '2x' : ratio >= 1 ? 'break-even' : 'pre-even';
}

function analysisKey(market, stats) {
  return JSON.stringify({
    ticker: market.ticker, line: market.line, yesAsk: market.yesAsk, noAsk: market.noAsk,
    statsFetchedAt: stats.fetchedAt, teamId: stats.team?.id, opponentId: stats.opponent?.id,
  });
}

export default function AIPredictions({ dataFolder, onActivity, scanRequest }) {
  const [markets, setMarkets] = useState([]);
  const [trades, setTrades] = useState([]);
  const [seasonProfile, setSeasonProfile] = useState(null);
  const [seasonProfiles, setSeasonProfiles] = useState([]);
  const [selectedPieceId, setSelectedPieceId] = useState('');
  const [paperMode, setPaperMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [debugEntries, setDebugEntries] = useState([]);
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const [autoRetryAt, setAutoRetryAt] = useState(null);
  const [autoRetrySeconds, setAutoRetrySeconds] = useState(0);
  const autoRetryTimerRef = useRef(null);
  const [error, setError] = useState('');
  const [season, setSeason] = useState(dataFolder?.season || 1);
  const [week, setWeek] = useState('week1');
  const [analyses, setAnalyses] = useState({});
  const [statsByKey, setStatsByKey] = useState({});
  const [statsResolved, setStatsResolved] = useState(false);
  const [analysisErrors, setAnalysisErrors] = useState({});
  const [sideByKey, setSideByKey] = useState({});
  const [sliderIdx, setSliderIdx] = useState({});
  const [selectedEntries, setSelectedEntries] = useState([]);
  const [piecePrompt, setPiecePrompt] = useState('');
  const [pieceQuotaFilled, setPieceQuotaFilled] = useState(false);
  const [reassessPredictionKey, setReassessPredictionKey] = useState('');
  const [otherPieceTickers, setOtherPieceTickers] = useState([]);
  const handledScanRef = useRef(null);
  const lastStatsRefreshRef = useRef(null);
  const root = dataFolder?.handle;

  useEffect(() => {
    if (!/\{\d+\}$/.test(progress)) return undefined;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const match = current.match(/\{(\d+)\}$/);
        if (!match) return current;
        return current.replace(/\{\d+\}$/, '{' + Math.max(0, Number(match[1]) - 1) + '}');
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [progress]);

  useEffect(() => {
    if (!root) return;
    (async () => {
      const cached = await readCache(root);
      setMarkets(cached.markets);
      setSelectedEntries(await readAIPredictionSelections(root));
      const settings = await readSettings(root);
      setPaperMode(!!settings.paperMode);
      const activeSeason = await latestSeason(root);
      if (activeSeason && activeSeason !== season) setSeason(activeSeason);
      const profiles = await listSeasonProfiles(root);
      setSeasonProfiles(profiles);
      const requestedProfileId = scanRequest?.requestId !== handledScanRef.current ? scanRequest?.profileId : null;
      const activeProfile = profiles.find((profile) => profile.id === requestedProfileId) || profiles.find((profile) => profile.id === selectedPieceId) || profiles.find((profile) => profile.id === 'season-' + (activeSeason || season)) || null;
      if (activeProfile && selectedPieceId !== activeProfile.id) setSelectedPieceId(activeProfile.id);
      if (activeProfile && activeProfile.season !== season) setSeason(activeProfile.season);
      setSeasonProfile(activeProfile);
      setPiecePrompt(activeProfile?.piecePrompt || activeProfile?.pieceMessages?.filter((item) => item.role === 'user').slice(-1)[0]?.content || '');
      const otherProfiles = profiles.filter((profile) => profile.id !== activeProfile?.id && profile.activePlayer !== false);
      const otherTrades = (await Promise.all(otherProfiles.map((profile) => readSeasonTrades(root, profile)))).flat();
      setOtherPieceTickers([...otherTrades.map((trade) => trade.ticker), ...otherProfiles.flatMap((profile) => (profile.selectedLines || []).map((item) => item.ticker))].filter(Boolean));
      const profileTrades = activeProfile ? await readSeasonTrades(root, activeProfile) : [];
      const accruedProfit = profileTrades.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
      setPieceQuotaFilled(!!activeProfile && accruedProfit >= (Number(activeProfile.quotaValue ?? activeProfile.balance) || 0));
      const activeWeek = activeProfile?.nextScheduledWeek || week;
      if (activeWeek !== week) setWeek(activeWeek);
      setTrades(await readTrades(root, activeProfile?.season || activeSeason || season, activeWeek));
    })().catch((e) => setError(e.message));
  }, [root, season, week, scanRequest?.requestId]);

  const { predictions } = useMemo(() => ({
    predictions: computePredictions(markets).predictions.filter((p) =>
      (['NFL', 'NBA', 'MLB'].includes(String(p.league).toUpperCase()) || selectedEntries.includes(p.key)) &&
      (!seasonProfile?.strategy || p.strategy === seasonProfile.strategy)
    ),
  }), [markets, selectedEntries, seasonProfile?.strategy]);
  const predictionDatasetSignature = JSON.stringify(predictions.map((p) => ({ key: p.key, event: p.event, opponent: eventOpponent(markets, p.event, p.team), gameTime: p.gameTime || p.expectedExpiration || p.closeTime || null, lines: p.lines.map((line) => [line.ticker, line.line, line.yesAsk, line.noAsk]), recommended: p.recommended?.ticker || null })));

  useEffect(() => {
    if (!root || !seasonProfile) return;
    const datasetSignature = predictionDatasetSignature;
    const previousRefresh = lastStatsRefreshRef.current;
    if (previousRefresh && previousRefresh.root === root && previousRefresh.profileId === seasonProfile.id && previousRefresh.signature === datasetSignature) return;
    const refreshRecord = { root, profileId: seasonProfile.id, signature: datasetSignature, cancelled: false, completed: false };
    lastStatsRefreshRef.current = refreshRecord;
    let cancelled = false;
    if (!markets.length || !predictions.length) {
      setStatsByKey({}); setAnalyses({}); setAnalysisErrors({}); setStatsResolved(true);
      setProgress('No upcoming games found in the current market dataset.');
      setDebugEntries([{ time: new Date().toLocaleTimeString(), message: 'DATASET EMPTY · market entries=' + markets.length + ' · eligible prediction entries=' + predictions.length + ' · no statistics requests started.' }]);
      setBusy(false);
      refreshRecord.completed = true;
      return () => { cancelled = true; };
    }
    async function run() {
      setBusy(true); setError(''); setProgress('Resolving league statistics and MLB weather…');
      setStatsResolved(false);
      setDebugEntries([{ time: new Date().toLocaleTimeString(), message: 'Refresh started · ' + predictions.length + ' prediction entries · ' + new Date().toISOString() }]);
      const nextStats = {}, nextAnalyses = {}, nextErrors = {};
      const statsForPrediction = new Map();
      const reportProgress = (label) => {
        setProgress(label);
        setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'STEP · ' + label }].slice(-40));
      };
      try {
        const currentSeason = new Date().getFullYear();
        const orderedPredictions = [...predictions].sort((a, b) => {
        const at = Date.parse(a.gameTime || a.expectedExpiration || a.closeTime || '') || Infinity;
        const bt = Date.parse(b.gameTime || b.expectedExpiration || b.closeTime || '') || Infinity;
        return at - bt;
      });
      for (const p of orderedPredictions) {
          if (cancelled) return;
          const league = leagueFor(p);
          const opponent = eventOpponent(markets, p.event, p.team);
          if (!league || !opponent) {
            nextErrors[p.key] = !league ? 'Unsupported league for ESPN statistics.' : 'Could not identify the opponent in this event.';
            setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'SKIP · ' + p.team + ' · ' + nextErrors[p.key] }].slice(-40));
            continue;
          }
          const gameTime = p.gameTime || p.expectedExpiration || p.closeTime;
          const params = { league, team: p.team, opponent, season: currentSeason, seasonType: '2' };
          const key = teamStatsCacheKey({ ...params, season: league === 'MLB' ? gameTime : currentSeason });
          let entry = await getCachedTeamStats(root, key, league === 'MLB' ? 60 * 60 * 1000 : undefined);
          if (entry) {
            setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'CACHE HIT · ' + league + ' · ' + p.team + ' vs ' + opponent + ' · fetched ' + (entry.data?.fetchedAt || 'timestamp unavailable') }].slice(-40));
            setProgress('Cached ' + league + ' statistics: ' + p.team + ' vs ' + opponent);
          } else {
            const startedAt = Date.now();
            setProgress((league === 'MLB' ? 'MLB statistics: ' : 'ESPN league statistics: ') + p.team + ' vs ' + opponent + ' {5}');
            setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'REQUEST · ' + league + ' · ' + p.team + ' vs ' + opponent + ' · provider=' + (league === 'MLB' ? 'MLB Stats API + Open-Meteo' : 'Azure GetTeamStatistics / ESPN') + ' · timeout=5000ms' }].slice(-40));
            try {
              const raw = league === 'MLB'
                ? await fetchMLBTeamStatistics({ team: p.team, opponent, gameTime, onProgress: reportProgress })
                : normalizeStats(await fetchTeamStatistics({ ...params, onProgress: reportProgress }), p.team, opponent);
              entry = await setCachedTeamStats(root, key, raw);
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'SUCCESS · ' + league + ' · ' + p.team + ' vs ' + opponent + ' · ' + (Date.now() - startedAt) + 'ms · provider=' + (raw.provider || 'ESPN') }].slice(-40));
            } catch (requestError) {
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'FAILED · ' + league + ' · ' + p.team + ' vs ' + opponent + ' · ' + (requestError.message || String(requestError)) }].slice(-40));
              throw requestError;
            }
          }
          const stats = entry.data;
          if (!stats?.team || stats.team.pointsPerGame == null || stats.opponent?.pointsAllowedPerGame == null || (league === 'MLB' && (!stats.weather || stats.weather.rainoutRisk === true))) {
            nextErrors[p.key] = league === 'MLB' && stats?.weather?.rainoutRisk ? 'Likely rainout: MLB market excluded.' : league === 'MLB' ? 'MLB statistics or batting-weather forecast is incomplete.' : 'ESPN response is missing team PPG or opponent PA.';
            setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'DATA CHECK FAILED · ' + p.team + ' · ' + nextErrors[p.key] + ' · provider=' + (stats?.provider || 'unknown') + ' · teamPPG=' + stats?.team?.pointsPerGame + ' · opponentPA=' + stats?.opponent?.pointsAllowedPerGame + ' · weather=' + (stats?.weather ? JSON.stringify(stats.weather) : 'missing') }].slice(-40));
            continue;
          }
          setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'DATA VALID · ' + p.team + ' · teamPPG=' + stats.team.pointsPerGame + ' · opponentPA=' + stats.opponent.pointsAllowedPerGame + (league === 'MLB' ? ' · weather=' + JSON.stringify(stats.weather) : '') }].slice(-40));
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
            const league = leagueFor(p);
            const market = {
              ticker: line.ticker, title: p.team + ' over ' + line.line + (league === 'MLB' ? ' runs' : ' points'),
              league, team: p.team, opponent: stats.opponent?.name || '',
              line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk,
              closeTime: p.closeTime || p.expectedExpiration || null,
              gameTime: p.gameTime || p.expectedExpiration || null,
            };
            const cacheKey = analysisKey(market, stats);
            const cached = await getCachedAnalysis(root, cacheKey);
            if (cached) return { ticker: line.ticker, data: cached.data };
            const data = await analyzeMarket({
              market,
              teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
              opponentStats: stats.opponent,
              context: league === 'MLB'
                ? { source: stats.provider, season: stats.season, statisticsFetchedAt: stats.fetchedAt, mlb: { weather: stats.weather, schedule: stats.schedule, modelInputs: stats.modelInputs, dataQuality: stats.dataQuality } }
                : { source: 'ESPN', season: stats.season, seasonType: stats.seasonType, statisticsFetchedAt: stats.fetchedAt },
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
        setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'REFRESH COMPLETE · valid stats=' + Object.keys(nextStats).length + ' · stats errors=' + Object.keys(nextErrors).length + ' · AI analyses=' + Object.keys(nextAnalyses).length }].slice(-40));
        setStatsByKey(nextStats); setAnalyses(nextAnalyses); setAnalysisErrors(nextErrors); setStatsResolved(true); setProgress('');
      } catch (e) {
        if (!cancelled) {
          setStatsByKey(nextStats); setAnalyses(nextAnalyses); setAnalysisErrors(nextErrors); setStatsResolved(true);
          setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'REFRESH ERROR · ' + (e.message || String(e)) }].slice(-40));
          setError(e.message || 'Prediction analysis failed'); setProgress('');
        }
      } finally {
        refreshRecord.completed = true;
        if (!cancelled) setBusy(false);
      }
    }
    run();
    // Do not cancel on effect cleanup: React StrictMode replays effects in development.
    // The signature guard above prevents duplicate refreshes for the same dataset.
    return undefined;
  }, [root, predictionDatasetSignature, seasonProfile?.id, autoRetryCount]);

  useEffect(() => {
    if (!autoRetryAt) return undefined;
    const tick = () => setAutoRetrySeconds(Math.max(0, Math.ceil((autoRetryAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [autoRetryAt]);

  useEffect(() => () => { if (autoRetryTimerRef.current) window.clearTimeout(autoRetryTimerRef.current); }, []);

  function sideFor(p) { return sideByKey[p.key] || (leagueFor(p) === 'MLB' ? 'NO' : 'YES'); }
  function idxFor(p) {
    if (sliderIdx[p.key] != null) return Math.max(0, Math.min(sliderIdx[p.key], p.lines.length - 1));
    return recommendedIndex(p);
  }

  function commitSliderSelection(p, value) {
    const next = Math.max(0, Math.min(Number(value) || 0, p.lines.length - 1));
    setSliderIdx((old) => ({ ...old, [p.key]: next }));
    analyzeSelectedLine(p, p.lines[next]);
  }

  async function analyzeSelectedLine(p, line) {
    const stats = statsByKey[p.key];
    if (!root || !stats || !line) return null;
    if (analyses[line.ticker]) return analyses[line.ticker];
    setBusy(true);
    setProgress('Analyzing selected line: ' + p.team + ' over ' + line.line);
    setAnalysisErrors((old) => ({ ...old, [p.key]: '' }));
    try {
      const league = leagueFor(p);
      const market = {
        ticker: line.ticker, title: p.team + ' over ' + line.line + (league === 'MLB' ? ' runs' : ' points'),
        league, team: p.team, opponent: stats.opponent?.name || '',
        line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk,
        closeTime: p.closeTime || p.expectedExpiration || null,
        gameTime: p.gameTime || p.expectedExpiration || null,
      };
      const cacheKey = analysisKey(market, stats);
      const cached = await getCachedAnalysis(root, cacheKey);
      const data = cached?.data || await analyzeMarket({
        market,
        teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
        opponentStats: stats.opponent,
        context: league === 'MLB'
          ? { source: stats.provider, season: stats.season, statisticsFetchedAt: stats.fetchedAt, mlb: { weather: stats.weather, schedule: stats.schedule, modelInputs: stats.modelInputs, dataQuality: stats.dataQuality } }
          : { source: 'ESPN', season: stats.season, seasonType: stats.seasonType, statisticsFetchedAt: stats.fetchedAt },
      });
      if (!cached) await setCachedAnalysis(root, cacheKey, data);
      setAnalyses((old) => ({ ...old, [line.ticker]: data }));
      return data;
    } catch (e) {
      setAnalysisErrors((old) => ({ ...old, [p.key]: e.message || 'Selected-line analysis failed' }));
      return null;
    } finally {
      setBusy(false);
      setProgress('');
    }
  }
  async function reassessSelectedLine(p, line) {
    const stats = statsByKey[p.key];
    const baseline = analyses[line?.ticker];
    if (!root || !stats || !line || !baseline || !piecePrompt.trim()) return;
    setBusy(true); setError('');
    setProgress('Reassessing ' + p.team + ' over ' + line.line + ' against the piece instruction…');
    try {
      const league = leagueFor(p);
      const market = { ticker: line.ticker, title: p.team + ' over ' + line.line + (league === 'MLB' ? ' runs' : ' points'), league, team: p.team, opponent: stats.opponent?.name || '', line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk, closeTime: p.closeTime || p.expectedExpiration || null, gameTime: p.gameTime || p.expectedExpiration || null };
      const revised = await analyzeMarket({
        market,
        teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
        opponentStats: stats.opponent,
        context: league === 'MLB' ? { source: stats.provider, season: stats.season, statisticsFetchedAt: stats.fetchedAt, mlb: { weather: stats.weather, schedule: stats.schedule, modelInputs: stats.modelInputs, dataQuality: stats.dataQuality } } : { source: 'ESPN', season: stats.season, seasonType: stats.seasonType, statisticsFetchedAt: stats.fetchedAt },
        pieceInstruction: piecePrompt.trim(),
        baselinePrediction: baseline.prediction,
      });
      setAnalyses((old) => ({ ...old, [line.ticker]: { ...revised, baselinePrediction: baseline.prediction, pieceInstruction: piecePrompt.trim() } }));
      setProgress('AI reassessment complete. Compare the revised probability with the original.');
    } catch (e) { setError(e.message || 'Piece instruction reassessment failed'); }
    finally { setBusy(false); }
  }


  useEffect(() => {
    const isAuto = seasonProfile?.auto === true;
    if (scanRequest?.requestId && seasonProfile?.id !== scanRequest.profileId) return;
    // Every completed dataset gets one piece-selection pass, even when Auto is off.
    // Auto controls only the 60-second retry after a no-selection result.
    const attemptKey = (scanRequest?.requestId || ('dataset-' + seasonProfile?.id)) + ':' + autoRetryCount + ':' + predictionDatasetSignature;
    if (handledScanRef.current === attemptKey) return;
    if (!seasonProfile || !statsResolved) return;
    handledScanRef.current = attemptKey;
    if (autoRetryTimerRef.current) { window.clearTimeout(autoRetryTimerRef.current); autoRetryTimerRef.current = null; }
    setAutoRetryAt(null); setAutoRetrySeconds(0);
    (async () => {
      setError('');
      setProgress('Start next week: scanning upcoming games and every slider line…');
      const selected = {};
      const orderedPredictions = [...predictions].sort((a, b) => {
        const at = Date.parse(a.gameTime || a.expectedExpiration || a.closeTime || '') || Infinity;
        const bt = Date.parse(b.gameTime || b.expectedExpiration || b.closeTime || '') || Infinity;
        return at - bt;
      });
      const confirmedReturns = confirmedWalletReturns(await readSeasonTrades(root, seasonProfile));
      const worthCondition = activeWorthCondition(seasonProfile, confirmedReturns);
      const mode = seasonProfile.strategiesByWorthCondition?.[worthCondition] || (seasonProfile.selectionStrategy && seasonProfile.selectionStrategy !== 'baseball-no' ? seasonProfile.selectionStrategy : '');
      const risk = seasonProfile.riskByWorthCondition?.[worthCondition] || '';
      const baseballEnabled = seasonProfile.baseballNoStrategy === true || seasonProfile.selectionStrategy === 'baseball-no';
      const gates = { standard: { probability: 0.76, payout: 1.34 }, value: { probability: 0.70, payout: 1.51 }, highroller: { probability: 0.61, payout: 1.67 } };
      if (!mode || !risk) { setProgress('Piece is not ready for play: configure strategy and risk for its current worth condition.'); setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'SCAN STOPPED · strategy or risk is not configured for ' + worthCondition }].slice(-40)); return; }
      const gate = { ...(gates[mode] || gates.standard) };
      if (risk === 'probability') { gate.payout = 1.20; }
      if (risk === 'value') { gate.probability = Math.max(0.5, gate.probability - 0.06); }
      let scannedLines = 0;
      let evaluatedSides = 0;
      const selectionList = [];
      const analysisByTicker = new Map();
      const scannedTickers = new Set();
      const qualifies = (p, line, analysis, side, stats) => {
        const probability = probabilityFor(analysis, side);
        const ask = askFor(line, side);
        const payout = ask > 0 ? 1 / ask : 0;
        if (probability == null || ask == null) return null;
        if (leagueFor(p) === 'MLB') {
          if (!baseballEnabled || side !== 'NO' || analysis.mlbEligibility?.eligible !== true || probability < 0.90) return null;
        } else {
          if (mode === 'value' && !pieceQuotaFilled) return null;
          if (mode === 'value') {
            const knownPPG = Math.min(Number(stats.team?.pointsPerGame) || Infinity, Number(stats.team?.recent5PPG) || Number(stats.team?.pointsPerGame) || Infinity);
            if (!Number.isFinite(knownPPG) || Number(line.line) > knownPPG * 0.9) return null;
          }
          if (mode === 'highroller') {
            const teamPPG = Number(stats.team?.pointsPerGame) || 0;
            const opponentPA = Number(stats.opponent?.pointsAllowedPerGame) || 0;
            const shootout = leagueFor(p) === 'NFL' ? teamPPG >= 22 && opponentPA >= 22
              : leagueFor(p) === 'NBA' ? teamPPG >= 110 && opponentPA >= 110 : false;
            if (!shootout) return null;
          }
          if (probability < gate.probability || payout <= gate.payout) return null;
        }
        const edge = probability - ask;
        if (edge <= 0) return null;
        return {
          predictionKey: p.key, index: p.lines.findIndex((item) => item.ticker === line.ticker),
          ticker: line.ticker, event: p.event, team: p.team, league: p.league,
          line: line.line, side, probability, ask, payoutMultiple: payout, edge,
          strategy: mode, risk, qualifiedAt: new Date().toISOString(),
        };
      };
      for (const p of orderedPredictions) {
        const gameTime = p.gameTime || p.expectedExpiration || p.closeTime;
        if (gameTime && Number.isFinite(Date.parse(gameTime)) && Date.parse(gameTime) <= Date.now()) continue;
        const stats = statsByKey[p.key];
        if (!stats) continue;
        const isBaseball = leagueFor(p) === 'MLB';
        if (isBaseball && !baseballEnabled) continue;

        // Pass 1: YES travels from the low end of the ladder to the high end.
        // Pass 2: NO starts at the opposite end and travels back toward the low end.
        const sidePasses = isBaseball
          ? [{ side: 'NO', indices: scanLineIndices(p.lines, 'NO', leagueFor(p)) }]
          : [
              { side: 'YES', indices: scanLineIndices(p.lines, 'YES', leagueFor(p)) },
              { side: 'NO', indices: scanLineIndices(p.lines, 'NO', leagueFor(p)) },
            ];
        for (const pass of sidePasses) {
          for (const lineIndex of pass.indices) {
            const line = p.lines[lineIndex];
            setSliderIdx((old) => ({ ...old, [p.key]: lineIndex }));
            setSideByKey((old) => ({ ...old, [p.key]: pass.side }));
            setProgress('Scanning ' + p.team + ' · ' + pass.side + ' · line ' + line.line + ' · ' + (pass.side === 'YES' ? 'left to right' : 'right to left'));
            let analysis = analysisByTicker.get(line.ticker);
            if (!analysis) {
              analysis = await analyzeSelectedLine(p, line);
              if (analysis) analysisByTicker.set(line.ticker, analysis);
            }
            if (!scannedTickers.has(line.ticker)) { scannedTickers.add(line.ticker); scannedLines += 1; }
            evaluatedSides += 1;
            // Report every rung with the live model probability, payout, and
            // both strategy floors. Payout failure does not stop the pass.
            // YES scans left-to-right; NO scans right-to-left.
            const probability = analysis?.prediction ? probabilityFor(analysis, pass.side) : null;
            const ask = askFor(line, pass.side);
            const payout = ask > 0 ? 1 / ask : null;
            const probabilityFloor = isBaseball ? 0.90 : gate.probability;
            const payoutFloor = isBaseball ? null : gate.payout;
            const probabilityText = probability == null ? 'n/a' : (probability * 100).toFixed(1) + '%';
            const payoutText = payout == null ? 'n/a' : payout.toFixed(2) + 'x';
            const floorsText = 'probability floor=' + (probabilityFloor * 100).toFixed(1) + '% · payout floor=' + (payoutFloor == null ? 'N/A (MLB)' : '>' + payoutFloor.toFixed(2) + 'x');
            if (!analysis?.prediction) {
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'LINE CHECK · ' + p.team + ' · ' + pass.side + ' ' + line.line + ' · probability=n/a · payout=' + payoutText + ' · ' + floorsText + ' · result=analysis unavailable; continuing.' }].slice(-40));
              continue;
            }
            if (probability != null && probability < probabilityFloor) {
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'LINE CHECK · ' + p.team + ' · ' + pass.side + ' ' + line.line + ' · probability=' + probabilityText + ' · payout=' + payoutText + ' · ' + floorsText + ' · result=STOP: probability below floor.' }].slice(-40));
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'PASS STOP · ' + p.team + ' · ' + pass.side + ' · line ' + line.line + ' probability=' + probabilityText + ' fell below floor=' + (probabilityFloor * 100).toFixed(1) + '%. Stopping this direction and moving to the next side or ladder.' }].slice(-40));
              break;
            }
            const candidate = qualifies(p, line, analysis, pass.side, stats);
            const payoutPass = isBaseball || (payout != null && payout > gate.payout);
            const probabilityPass = probability != null && probability >= probabilityFloor;
            const lineResult = candidate ? 'QUALIFIED' : !probabilityPass ? 'probability unavailable' : !payoutPass ? 'payout below floor; continuing scan' : 'other strategy/edge filter not met';
            setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'LINE CHECK · ' + p.team + ' · ' + pass.side + ' ' + line.line + ' · probability=' + probabilityText + ' · payout=' + payoutText + ' · ' + floorsText + ' · result=' + lineResult + (ask == null ? ' · ask unavailable' : ' · ask=' + (ask * 100).toFixed(1) + '¢') }].slice(-40));
            if (candidate) {
              selectionList.push(candidate);
              setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'QUALIFIED · ' + p.team + ' · ' + pass.side + ' ' + line.line + ' · probability=' + Math.round(candidate.probability * 100) + '% · ask=' + Math.round(candidate.ask * 100) + '¢ · payout=' + candidate.payoutMultiple.toFixed(2) + 'x · edge=' + Math.round(candidate.edge * 100) + '¢' }].slice(-40));
            }
          }
        }
      }

      // Final interrogation is a separate post-qualification challenge. The
      // scanner's existing gates above remain untouched. Every qualified choice
      // is interrogated and written to Records/Prediction History before ranking.
      const interrogatedCandidates = [];
      for (const candidate of selectionList) {
        const prediction = orderedPredictions.find((item) => item.key === candidate.predictionKey);
        const line = prediction?.lines?.find((item) => item.ticker === candidate.ticker);
        const stats = statsByKey[candidate.predictionKey];
        const baseline = analysisByTicker.get(candidate.ticker) || analyses[candidate.ticker];
        let review = null;
        let verdict = 'REVIEW';
        let finalProbability = candidate.side === 'YES' ? candidate.probability : 1 - candidate.probability;
        let reviewError = '';
        try {
          if (!prediction || !line || !stats || !baseline?.prediction) throw new Error('Candidate context or baseline analysis is missing.');
          const league = leagueFor(prediction);
          const market = {
            ticker: candidate.ticker,
            title: prediction.team + ' over ' + line.line + (league === 'MLB' ? ' runs' : ' points'),
            league, team: prediction.team, opponent: stats.opponent?.name || '',
            line: line.line, yesAsk: line.yesAsk, noAsk: line.noAsk,
            closeTime: prediction.closeTime || prediction.expectedExpiration || null,
            gameTime: prediction.gameTime || prediction.expectedExpiration || null,
          };
          review = await finalInterrogateCandidate({
            candidate, market,
            teamStats: { ...stats.team, modelInputs: stats.modelInputs, recentGames: stats.recentGames, dataQuality: stats.dataQuality },
            opponentStats: stats.opponent,
            baselinePrediction: baseline.prediction,
            pieceInstruction: piecePrompt || seasonProfile.piecePrompt || '',
            season: stats.season || new Date().getFullYear(),
          });
          verdict = review.verdict;
          finalProbability = Number(review.interrogation.probabilityYes);
          if (!Number.isFinite(finalProbability) || finalProbability < 0 || finalProbability > 1) throw new Error('Final interrogation returned an invalid probability.');
        } catch (error) {
          reviewError = error.message || String(error);
          review = { verdict: 'REVIEW', interrogation: { verdict: 'REVIEW', reasoning: ['Final interrogation could not complete.'], missingData: [reviewError] }, error: reviewError };
          verdict = 'REVIEW';
        }
        const sideProbability = candidate.side === 'YES' ? finalProbability : 1 - finalProbability;
        const reviewed = { ...candidate, finalVerdict: verdict, finalProbabilityYes: finalProbability, finalSideProbability: sideProbability, finalInterrogation: review, finalInterrogatedAt: new Date().toISOString(), finalReviewError: reviewError };
        interrogatedCandidates.push(reviewed);
        try {
          await appendQualifiedCandidate(root, {
            id: 'qualified-' + seasonProfile.id + '-' + candidate.ticker + '-' + candidate.side,
            timestamp: new Date().toISOString(),
            seasonPieceId: seasonProfile.id, season: seasonProfile.season, week,
            matchup: prediction ? prediction.team + ' vs ' + (stats?.opponent?.name || 'opponent') : candidate.event,
            market: prediction ? prediction.team + ' over ' + candidate.line + (candidate.league === 'MLB' ? ' runs' : ' pts') : candidate.ticker,
            ticker: candidate.ticker, line: candidate.line, side: candidate.side,
            price: candidate.ask * 100, probability: candidate.probability,
            marketProbability: candidate.ask, edge: candidate.edge,
            payoutMultiple: candidate.payoutMultiple, strategy: candidate.strategy, risk: candidate.risk,
            status: 'qualified-' + verdict.toLowerCase(),
            finalVerdict: verdict, finalProbabilityYes: finalProbability,
            baselineAnalysis: baseline?.prediction || null, finalInterrogation: review,
          });
        } catch (error) {
          setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'RECORD SAVE FAILED · ' + candidate.ticker + ' · ' + error.message }].slice(-40));
        }
        setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'FINAL INTERROGATION · ' + candidate.team + ' · ' + candidate.side + ' ' + candidate.line + ' · verdict=' + verdict + ' · final side probability=' + (sideProbability * 100).toFixed(1) + '%' + (reviewError ? ' · error=' + reviewError : '') }].slice(-40));
      }
      const rankedCandidates = interrogatedCandidates.filter((item) => item.finalVerdict === 'KEEP').sort((a, b) => {
        if (risk === 'probability') return b.finalSideProbability - a.finalSideProbability || b.edge - a.edge || b.payoutMultiple - a.payoutMultiple;
        if (risk === 'value') return b.edge - a.edge || b.payoutMultiple - a.payoutMultiple || b.finalSideProbability - a.finalSideProbability;
        return b.edge - a.edge || b.finalSideProbability - a.finalSideProbability || b.payoutMultiple - a.payoutMultiple;
      });
      const finalSelection = rankedCandidates[0] || null;
      const orderedSelections = finalSelection ? [finalSelection] : [];
      const finalSelectionList = interrogatedCandidates;
      if (finalSelection) {
        setSliderIdx((old) => ({ ...old, [finalSelection.predictionKey]: finalSelection.index }));
        setSideByKey((old) => ({ ...old, [finalSelection.predictionKey]: finalSelection.side }));
      }
      const selectedLines = orderedSelections.map(({ predictionKey, ticker, event, team, league, line, side }) => ({ predictionKey, ticker, event, team, league, line, side }));
      const resolvedAt = new Date().toISOString();
      const selectionResolution = { status: orderedSelections.length ? 'selected' : 'none', phase: 'final-interrogation-complete', resolvedAt, checkedGames: orderedPredictions.length, scannedLines, evaluatedSides, qualifiedGames: [...new Set(selectionList.map((item) => item.predictionKey))].length, qualifiedCandidates: selectionList.length, selectionList: finalSelectionList, selectedGames: orderedSelections.length, selectedByRisk: risk, finalInterrogation: true, keptCandidates: rankedCandidates.length, rejectedCandidates: interrogatedCandidates.filter((item) => item.finalVerdict === 'REJECT').length, reviewCandidates: interrogatedCandidates.filter((item) => item.finalVerdict === 'REVIEW').length, message: orderedSelections.length ? 'Selected 1 matchup-vetted game from ' + selectionList.length + ' strategy-qualified candidate(s).' : 'No candidate passed final matchup interrogation.' };
      try { const updatedProfile = await updateSeasonProfile(root, seasonProfile.id, { selectionList, selectedLines, selectionResolution }); setSeasonProfile(updatedProfile); } catch (e) { setError(e.message || 'Could not save piece selections'); }
      if (orderedSelections.length) {
        setProgress('Selection complete · 1 matchup-vetted game selected from ' + selectionList.length + ' qualified candidates; ' + rankedCandidates.length + ' passed final interrogation.');
        setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'SELECTION RESOLVED · scanned ' + scannedLines + ' lines and evaluated ' + evaluatedSides + ' side(s); ' + interrogatedCandidates.length + ' qualified candidates interrogated and recorded; ' + rankedCandidates.length + ' passed final review; final selection=' + (finalSelection ? finalSelection.ticker + ' ' + finalSelection.side : 'none') + ' using risk=' + risk + '.' }].slice(-40));
        onActivity?.('WEEK_SCAN_COMPLETE', '1 final selection chosen from ' + selectionList.length + ' qualified candidates for ' + seasonProfile.name);
      } else {
        const message = selectionList.length ? 'No candidate passed final matchup interrogation.' : 'No qualifying game found in the current dataset.';
        setProgress(message + (isAuto ? ' Next automatic scan in 60 seconds.' : ' Auto is off; waiting for the next manual scan.'));
        setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'NO SELECTION · checked ' + orderedPredictions.length + ' prediction entries and their available lines; none passed the piece strategy/risk rules.' }].slice(-40));
        if (isAuto) {
          const retryAt = Date.now() + 60000;
          setAutoRetryAt(retryAt); setAutoRetrySeconds(60);
          autoRetryTimerRef.current = window.setTimeout(() => {
            autoRetryTimerRef.current = null;
            setAutoRetryAt(null); setAutoRetrySeconds(0);
            lastStatsRefreshRef.current = null;
            setStatsResolved(false);
            setAutoRetryCount((value) => value + 1);
          }, 60000);
        }
      }
    })().catch((e) => { setError(e.message || 'Weekly scan failed'); setDebugEntries((old) => [...old, { time: new Date().toLocaleTimeString(), message: 'SCAN ERROR · ' + (e.message || String(e)) }].slice(-40)); });
  }, [scanRequest, seasonProfile, predictions, predictionDatasetSignature, statsByKey, statsResolved, autoRetryCount]);

  function setSide(p, side) {
    setSideByKey((old) => ({ ...old, [p.key]: side }));
    setSliderIdx((old) => { const next = { ...old }; delete next[p.key]; return next; });
  }
  async function recordPrediction(p) {
    if (!paperMode) { setError('Paper mode must be ON to record predictions.'); return; }
    if (seasonProfile?.activePlayer === false) { setError('This season piece is inactive after a loss and cannot record new matches.'); return; }
    if (!root) { setError('Connect a data folder first.'); return; }
    const line = p.lines[idxFor(p)], side = sideFor(p), analysis = analyses[line?.ticker];
    const probability = probabilityFor(analysis, side), ask = askFor(line, side);
    if (probability == null || ask == null) { setError('OpenAI analysis or executable ask is missing for this line.'); return; }
    if (leagueFor(p) === 'MLB') {
      if (!(seasonProfile?.baseballNoStrategy === true || seasonProfile?.selectionStrategy === 'baseball-no')) { setError('Enable Bet NO Strat (Baseball) in this piece to select baseball markets.'); return; }
      if (side !== 'NO' || analysis?.mlbEligibility?.eligible !== true || probability < 0.90) { setError('Baseball NO strategy requires the original strict MLB eligibility and 90% probability rules.'); return; }
    }
    if (leagueFor(p) !== 'MLB') {
      const confirmedReturns = confirmedWalletReturns(await readSeasonTrades(root, seasonProfile));
      const currentCondition = activeWorthCondition(seasonProfile, confirmedReturns);
      const mode = seasonProfile?.strategiesByWorthCondition?.[currentCondition] || (seasonProfile?.selectionStrategy && seasonProfile.selectionStrategy !== 'baseball-no' ? seasonProfile.selectionStrategy : '');
      const risk = seasonProfile?.riskByWorthCondition?.[currentCondition] || '';
      if (!mode || !risk) { setError('This piece is not ready for play. Set strategy and risk for its current worth condition.'); return; }
      const gates = { standard: { probability: 0.76, payout: 1.34 }, value: { probability: 0.70, payout: 1.51 }, highroller: { probability: 0.61, payout: 1.67 } };
      const gate = { ...(gates[mode] || gates.standard) };
      if (risk === 'probability') { gate.payout = 1.20; }
      if (risk === 'value') { gate.probability = Math.max(0.5, gate.probability - 0.06); }
      const payout = ask > 0 ? 1 / ask : 0;
      if (mode === 'value' && !pieceQuotaFilled) { setError('Value strategy requires this piece to have filled its monetary quota.'); return; }
      if (mode === 'value') { const stats = statsByKey[p.key]; const knownPPG = Math.min(Number(stats?.team?.pointsPerGame) || Infinity, Number(stats?.team?.recent5PPG) || Number(stats?.team?.pointsPerGame) || Infinity); if (!Number.isFinite(knownPPG) || Number(line.line) > knownPPG * 0.9) { setError("Value strategy requires a line at least 10% below the team's season and recent scoring average."); return; } }
      if (mode === 'highroller') {
        const stats = statsByKey[p.key];
        const teamPPG = Number(stats?.team?.pointsPerGame) || 0;
        const opponentPA = Number(stats?.opponent?.pointsAllowedPerGame) || 0;
        const shootoutProfile = leagueFor(p) === 'NFL' ? teamPPG >= 22 && opponentPA >= 22
          : leagueFor(p) === 'NBA' ? teamPPG >= 110 && opponentPA >= 110 : false;
        if (!shootoutProfile) { setError('High Roller requires a high-scoring team profile against a weaker defense; this matchup does not meet the statistical screen.'); return; }
      }
      if (probability < gate.probability || payout <= gate.payout) { setError(mode + ' strategy thresholds not met: probability ' + Math.round(probability * 100) + '% / payout ' + payout.toFixed(2) + '×.'); return; }
    }
    if (trades.some((t) => t.ticker === line.ticker && t.side === side)) return;
    setBusy(true); setError('');
    try {
      const stats = statsByKey[p.key] || {}, ai = analysis.prediction || {};
      const trade = {
        id: line.ticker + '-' + side + '-' + Date.now(), timestamp: new Date().toISOString(),
        matchup: p.team + ' vs ' + (stats.opponent?.name || 'opponent') + ' · ' + closeDate(p.closeTime),
        market: p.team + ' over ' + line.line + (leagueFor(p) === 'MLB' ? ' runs' : ' pts'), side,
        price: Math.round(ask * 100), probability: Math.round(probability * 100),
        strategy: seasonProfile?.strategy || p.strategy || null, selectionStrategy: seasonProfile?.selectionStrategy || '', riskPreference: seasonProfile?.riskPreference || 'probability', seasonPieceId: seasonProfile?.id || null, week, ticker: line.ticker, line: line.line, marketProbability: ask,
        modelProbability: probability, edge: probability - ask, modelVersion: analysis.model || 'OpenAI',
        context: { team: stats.team, opponent: stats.opponent, modelInputs: stats.modelInputs, dataQuality: stats.dataQuality, weather: stats.weather || null, schedule: stats.schedule || null },
        reasoning: (ai.reasoning || []).join(' '), stake: 1, paper: true, status: 'open',
      };
      await appendTrade(root, season, week, trade);
      setTrades(await readTrades(root, season, week));
      onActivity?.('PREDICTION_RECORDED', side + ' ' + trade.market + ' · ' + Math.round(probability * 100) + '% · ' + cents(ask) + ' ask');
    } catch (e) { setError(e.message || 'Could not record prediction'); }
    finally { setBusy(false); }
  }

  async function removePredictionRecord(p, line, side) {
    const record = trades.find((t) => t.ticker === line?.ticker && t.side === side);
    if (!record || !root) return;
    setBusy(true); setError('');
    try {
      await deleteTrade(root, record.id);
      setTrades((old) => old.filter((t) => t.id !== record.id));
      onActivity?.('RECORD_REMOVED', 'Record removed · ' + record.market);
    } catch (e) { setError(e.message || 'Could not remove record'); }
    finally { setBusy(false); }
  }
  return (
    <div className="page-shell">
      <div className="page-heading">
        <div><div className="eyebrow">WORKSPACE</div><h1>AI Predictions</h1><p>Scanner-selected team-total ladders with league-specific statistics, MLB batting-weather screening, and OpenAI probability analysis.</p></div>
        <div className="status-pill">{busy ? 'Analyzing markets' : 'Analysis ready'}</div>
      </div>
      {!root && <div className="notice"><div className="notice-icon"><BrainCircuit size={18}/></div><div><b>Connect a data folder</b><span>ESPN and OpenAI results are cached in its meta folder.</span></div></div>}
      {error && <div className="notice error-notice"><b>{error}</b></div>}
      {(progress || debugEntries.length > 0) && <div className="notice" style={{display:'block'}}><div style={{display:'flex',alignItems:'center',gap:8}}><RefreshCw size={16}/><b>{progress || 'Refresh diagnostics'}</b></div>{autoRetryAt && <div style={{marginTop:6,fontVariantNumeric:'tabular-nums'}}>Next auto scan in {autoRetrySeconds}s</div>}<details open style={{marginTop:8}}><summary style={{cursor:'pointer',fontWeight:600}}>Debug details ({debugEntries.length})</summary><div style={{marginTop:8,maxHeight:220,overflowY:'auto',fontFamily:'monospace',fontSize:11,lineHeight:1.5,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{debugEntries.map((item,index)=><div key={index}>[{item.time}] {item.message}</div>)}</div></details></div>}
      <section className="panel">
        <div className="panel-heading"><div><h2>AI prediction entries · {predictions.length}</h2><p>NFL/NBA/MLB entries are populated automatically. The active season piece's strategy filters the entries shown here.</p></div></div>
        <div className="piece-instruction-box"><label htmlFor="active-season-piece">Active season piece</label><select id="active-season-piece" value={selectedPieceId} onChange={(e) => { const id = e.target.value; const profile = seasonProfiles.find((item) => item.id === id); setSelectedPieceId(id); if (profile) { setSeasonProfile(profile); setSeason(profile.season); setPiecePrompt(profile.piecePrompt || profile.pieceMessages?.filter((item) => item.role === 'user').slice(-1)[0]?.content || ''); setStatsByKey({}); setStatsResolved(false); setAnalyses({}); setAnalysisErrors({}); setAutoRetryCount(0); handledScanRef.current = null; } }}>{seasonProfiles.filter((profile) => profile.activePlayer !== false).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.selectionStrategy || "standard"}</option>)}</select><div className="piece-instruction-current"><b>Saved piece instruction</b><span>{piecePrompt || 'No instruction saved. Open the piece avatar on Dashboard or Game Day to send it a message.'}</span></div></div>
        {!predictions.length ? (
          <div className="empty-state"><div className="empty-icon"><AlertCircle size={22}/></div><b>No AI prediction entries selected</b><span>Open Live Market Scanner and use Add ladder on a team-total market.</span></div>
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
                <td style={{minWidth:190,width:190}}>
                  <div className="line-slider" style={{display:'flex',alignItems:'center',gap:10,width:190,minWidth:190}}>
                    <input
                      type="range"
                      disabled={busy}
                      min="0"
                      max={Math.max(0,p.lines.length-1)}
                      step="1"
                      value={idx}
                      style={{flex:'1 1 auto',width:130,minWidth:0,margin:0}}
                      onChange={(e)=>{setSliderIdx((old)=>({...old,[p.key]:Number(e.target.value)}));setReassessPredictionKey(p.key);}}
                      onPointerUp={(e)=>{setReassessPredictionKey(p.key);commitSliderSelection(p,e.currentTarget.value);}}
                      onKeyUp={(e)=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key)){setReassessPredictionKey(p.key);commitSliderSelection(p,e.currentTarget.value);}}}
                    />
                    <span className="line-value" style={{display:'inline-block',width:48,minWidth:48,textAlign:'right',fontVariantNumeric:'tabular-nums',flexShrink:0}}>{chosen?.line ?? '—'}</span>
                  </div>
                  <small className="line-range" style={{display:'block',whiteSpace:'nowrap'}}>{p.lines[0]?.line} – {p.lines[p.lines.length-1]?.line}</small>
                </td>
                <td><select value={side} onChange={(e)=>setSide(p,e.target.value)} aria-label={p.team + ' position side'}>{leagueFor(p) === 'MLB' ? <option value="NO">NO</option> : <><option value="YES">YES</option><option value="NO">NO</option></>}</select></td>
                <td>{cents(ask)}</td>
                <td><b className="prob">{probability == null ? '—' : Math.round(probability*100) + '%'}</b><small style={{display:'block'}}>{probability == null ? 'Awaiting analysis' : 'Model probability'}</small>{analysis?.reassessment && <small>Original {Math.round((side === 'NO' ? 1 - analysis.reassessment.baselineProbabilityYes : analysis.reassessment.baselineProbabilityYes) * 100)}% → reassessed {Math.round(probability * 100)}%</small>}</td>
                <td>{edge == null ? '—' : (edge >= 0 ? '+' : '') + Math.round(edge*100) + '¢'}</td>
                <td><b className="prob">{payout ? payout.toFixed(2) + '×' : '—'}</b></td>
                <td>{analysis ? <span className="status-pill strat-cliff">Ready</span> : <span className="status-pill">Pending</span>}</td>
                <td><button className="secondary-btn" disabled={busy || !root || (!already && (!paperMode || seasonProfile?.activePlayer === false || probability == null || ask == null || (leagueFor(p) === 'MLB' && (side !== 'NO' || analysis?.mlbEligibility?.eligible !== true))))} onClick={()=>already ? removePredictionRecord(p, chosen, side) : recordPrediction(p)}>{already ? 'Remove record' : 'Record'}</button><a className="icon-btn" href={'https://kalshi.com/markets/' + (p.event || chosen?.ticker || '').toLowerCase()} target="_blank" rel="noreferrer" title="Open on Kalshi" style={{marginLeft:6}}><ExternalLink size={14}/></a></td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
        <div className="table-foot"><span>OpenAI evaluates the selected line in each AI Prediction entry. Team PPG and opponent PA remain internal.</span><span>{predictions.length} entries</span></div>
      </section>
    </div>
  );
}
