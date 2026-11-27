import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, ExternalLink, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { readCache } from '../lib/marketCache';
import { readSettings, appendTrade, readTrades, readAIPredictionSelections, deleteTrade, latestSeason, listSeasonProfiles, updateSeasonProfile, readSeasonTrades } from '../lib/dataModel';
import { computePredictions } from '../lib/predictions';
import { fetchTeamStatistics } from '../lib/sportsStats';
import { fetchMLBTeamStatistics } from '../lib/mlbStats';
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

export default function AIPredictions({ dataFolder, onActivity, scanRequest }) {
  const [markets, setMarkets] = useState([]);
  const [trades, setTrades] = useState([]);
  const [seasonProfile, setSeasonProfile] = useState(null);
  const [seasonProfiles, setSeasonProfiles] = useState([]);
  const [selectedPieceId, setSelectedPieceId] = useState('');
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
  const [selectedEntries, setSelectedEntries] = useState([]);
  const [piecePrompt, setPiecePrompt] = useState('');
  const [pieceQuotaFilled, setPieceQuotaFilled] = useState(false);
  const [reassessPredictionKey, setReassessPredictionKey] = useState('');
  const [otherPieceTickers, setOtherPieceTickers] = useState([]);
  const handledScanRef = useRef(null);
  const root = dataFolder?.handle;

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
      setStatsByKey({});
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
  }, [root, season, week, scanRequest?.requestId, selectedPieceId]);

  const { predictions } = useMemo(() => ({
    predictions: computePredictions(markets).predictions.filter((p) =>
      (['NFL', 'NBA', 'MLB'].includes(String(p.league).toUpperCase()) || selectedEntries.includes(p.key)) &&
      (!seasonProfile?.strategy || p.strategy === seasonProfile.strategy)
    ),
  }), [markets, selectedEntries, seasonProfile?.strategy]);

  useEffect(() => {
    if (!root || !markets.length || !predictions.length) return;
    let cancelled = false;
    async function run() {
      setBusy(true); setError(''); setProgress('Resolving league statistics and MLB weather…');
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
          const gameTime = p.gameTime || p.expectedExpiration || p.closeTime;
          const params = { league, team: p.team, opponent, season: currentSeason, seasonType: '2' };
          const key = teamStatsCacheKey({ ...params, season: league === 'MLB' ? gameTime : currentSeason });
          let entry = await getCachedTeamStats(root, key, league === 'MLB' ? 60 * 60 * 1000 : undefined);
          if (!entry) {
            setProgress((league === 'MLB' ? 'Fetching MLB statistics/weather: ' : 'Fetching ESPN: ') + p.team + ' vs ' + opponent);
            const raw = league === 'MLB'
              ? await fetchMLBTeamStatistics({ team: p.team, opponent, gameTime })
              : normalizeStats(await fetchTeamStatistics(params), p.team, opponent);
            entry = await setCachedTeamStats(root, key, raw);
          }
          const stats = entry.data;
          if (!stats?.team || stats.team.pointsPerGame == null || stats.opponent?.pointsAllowedPerGame == null || (league === 'MLB' && (!stats.weather || stats.weather.rainoutRisk === true))) {
            nextErrors[p.key] = league === 'MLB' && stats?.weather?.rainoutRisk ? 'Likely rainout: MLB market excluded.' : league === 'MLB' ? 'MLB statistics or batting-weather forecast is incomplete.' : 'ESPN response is missing team PPG or opponent PA.';
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
    if (!scanRequest?.requestId || handledScanRef.current === scanRequest.requestId) return;
    if (!seasonProfile || seasonProfile.id !== scanRequest.profileId || !predictions.length || !Object.keys(statsByKey).length) return;
    handledScanRef.current = scanRequest.requestId;
    (async () => {
      setError('');
      setProgress('Start next week: scanning upcoming games and every slider line…');
      const selected = {};
      let bestOverall = null;
      const mode = seasonProfile.selectionStrategy || 'standard';
      const gates = { standard: { probability: 0.92, payout: 1.2 }, value: { probability: 0.84, payout: 1.4 }, highroller: { probability: 0.70, payout: 1.75 } };
      const gate = { ...(gates[mode] || gates.standard) };
      if (seasonProfile.riskPreference === 'probability') { gate.probability += 0.02; }
      if (seasonProfile.riskPreference === 'value') { gate.probability = Math.max(0.5, gate.probability - 0.02); gate.payout += 0.1; }
      for (const p of predictions) {
        const gameTime = p.gameTime || p.expectedExpiration || p.closeTime;
        if (gameTime && Number.isFinite(Date.parse(gameTime)) && Date.parse(gameTime) <= Date.now()) continue;
        const stats = statsByKey[p.key];
        if (!stats) continue;
        for (const line of p.lines) {
          setProgress('Scanning ' + p.team + ' line ' + line.line + ' · ' + p.league);
          const analysis = await analyzeSelectedLine(p, line);
          if (!analysis?.prediction) continue;
          const sides = leagueFor(p) === 'MLB' ? ['NO'] : ['YES', 'NO'];
          for (const side of sides) {
            const probability = probabilityFor(analysis, side);
            const ask = askFor(line, side);
            const payout = ask > 0 ? 1 / ask : 0;
            if (probability == null || ask == null) continue;
            if (['avoid-overlap', 'split'].includes(seasonProfile.diversityMode) && otherPieceTickers.includes(line.ticker)) continue;
            if (leagueFor(p) === 'MLB') {
              if (analysis.mlbEligibility?.eligible !== true || probability < 0.90) continue;
            } else {
              if (mode === 'value' && (!pieceQuotaFilled || seasonProfile.safe === true)) continue;
              if (mode === 'value') { const knownPPG = Math.min(Number(stats.team?.pointsPerGame) || Infinity, Number(stats.team?.recent5PPG) || Number(stats.team?.pointsPerGame) || Infinity); if (!Number.isFinite(knownPPG) || Number(line.line) > knownPPG * 0.9) continue; }
              if (mode === 'highroller') {
                const teamPPG = Number(stats.team?.pointsPerGame) || 0;
                const opponentPA = Number(stats.opponent?.pointsAllowedPerGame) || 0;
                const shootout = leagueFor(p) === 'NFL' ? teamPPG >= 22 && opponentPA >= 22
                  : leagueFor(p) === 'NBA' ? teamPPG >= 110 && opponentPA >= 110 : false;
                if (!shootout) continue;
              }
              if (probability < gate.probability || payout <= gate.payout) continue;
            }
            const value = probability - ask;
            if (!bestOverall || value > bestOverall.value) bestOverall = { predictionKey: p.key, index: p.lines.findIndex((item) => item.ticker === line.ticker), ticker: line.ticker, event: p.event, team: p.team, league: p.league, line: line.line, side, value };
          }
        }
      }
      if (bestOverall) selected[bestOverall.predictionKey] = bestOverall;
      setSliderIdx((old) => ({ ...old, ...Object.fromEntries(Object.entries(selected).map(([key, item]) => [key, item.index])) }));
      setSideByKey((old) => ({ ...old, ...Object.fromEntries(Object.entries(selected).map(([key, item]) => [key, item.side])) }));
      const selectedLines = Object.entries(selected).map(([predictionKey, item]) => ({ predictionKey, ticker: item.ticker, event: item.event, team: item.team, league: item.league, line: item.line, side: item.side }));
      try { const updatedProfile = await updateSeasonProfile(root, seasonProfile.id, { selectedLines }); setSeasonProfile(updatedProfile); } catch (e) { setError(e.message || 'Could not save piece selections'); }
      setProgress('Weekly scan complete · ' + Object.keys(selected).length + ' qualifying game selections found. Nothing was placed automatically.');
      onActivity?.('WEEK_SCAN_COMPLETE', Object.keys(selected).length + ' qualifying selections found for ' + seasonProfile.name);
    })().catch((e) => setError(e.message || 'Weekly scan failed'));
  }, [scanRequest, seasonProfile, predictions, statsByKey]);

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
    if (['avoid-overlap', 'split'].includes(seasonProfile?.diversityMode) && otherPieceTickers.includes(line.ticker)) { setError('This game is already selected by another active season piece. Diversity mode blocks overlap.'); return; }
    if (leagueFor(p) === 'MLB' && (side !== 'NO' || analysis?.mlbEligibility?.eligible !== true)) { setError('MLB is NO-only and this line has not passed the strict MLB eligibility checks.'); return; }
    if (leagueFor(p) !== 'MLB') {
      const mode = seasonProfile?.selectionStrategy || 'standard';
      const gates = { standard: { probability: 0.92, payout: 1.2 }, value: { probability: 0.84, payout: 1.4 }, highroller: { probability: 0.70, payout: 1.75 } };
      const gate = { ...(gates[mode] || gates.standard) };
      if (seasonProfile?.riskPreference === 'probability') { gate.probability += 0.02; }
      if (seasonProfile?.riskPreference === 'value') { gate.probability = Math.max(0.5, gate.probability - 0.02); gate.payout += 0.1; }
      const payout = ask > 0 ? 1 / ask : 0;
      if (mode === 'value' && (!pieceQuotaFilled || seasonProfile?.safe === true)) { setError('Value strategy requires this piece to have filled its monetary quota and not be marked Safe.'); return; }
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
        strategy: seasonProfile?.strategy || p.strategy || null, selectionStrategy: seasonProfile?.selectionStrategy || 'standard', riskPreference: seasonProfile?.riskPreference || 'probability', diversityMode: seasonProfile?.diversityMode || 'allow-overlap', seasonPieceId: seasonProfile?.id || null, week, ticker: line.ticker, line: line.line, marketProbability: ask,
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
      {progress && <div className="notice"><RefreshCw size={16}/><b>{progress}</b></div>}
      <section className="panel">
        <div className="panel-heading"><div><h2>AI prediction entries · {predictions.length}</h2><p>NFL/NBA/MLB entries are populated automatically. The active season piece's strategy filters the entries shown here.</p></div></div>
        <div className="piece-instruction-box"><label htmlFor="active-season-piece">Active season piece</label><select id="active-season-piece" value={selectedPieceId} onChange={(e) => setSelectedPieceId(e.target.value)}>{seasonProfiles.filter((profile) => profile.activePlayer !== false).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.selectionStrategy || "standard"}</option>)}</select><div className="piece-instruction-current"><b>Saved piece instruction</b><span>{piecePrompt || 'No instruction saved. Open the piece avatar on Dashboard or Game Day to send it a message.'}</span></div><button className="secondary-btn" disabled={busy || !piecePrompt.trim() || !predictions.length || !statsByKey[(predictions.find((p) => p.key === reassessPredictionKey) || predictions[0])?.key] || !analyses[(predictions.find((p) => p.key === reassessPredictionKey) || predictions[0])?.lines[idxFor(predictions.find((p) => p.key === reassessPredictionKey) || predictions[0])]?.ticker]} onClick={() => { const target = predictions.find((p) => p.key === reassessPredictionKey) || predictions[0]; if (target) reassessSelectedLine(target, target.lines[idxFor(target)]); }}>Reassess selected line for this piece</button></div>
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
