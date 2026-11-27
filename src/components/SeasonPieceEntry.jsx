import React, { useState } from 'react';
import { MessageCircle, Send, ChevronDown, CalendarDays, X } from 'lucide-react';
import SeasonToken from './SeasonToken';

const GRID_BANDS = ['pre-even', 'break-even', '2x', '3x'];
const STRATEGIES = [
  { id: 'standard', label: 'Standard', probability: 92, payout: '1.20×' },
  { id: 'value', label: 'Value', probability: 84, payout: '1.40×' },
  { id: 'highroller', label: 'High Roller', probability: 70, payout: '1.75×' },
  { id: 'baseball-no', label: 'Bet No Strat Baseball', probability: null, payout: 'MLB strict rules' },
];
const money = (value) => '$' + (Number(value) || 0).toFixed(2);

function strategyGrid(profile, currentWorth) {
  const quota = Math.max(0, Number(profile.quotaValue ?? profile.balance) || 0);
  const ratio = quota > 0 ? currentWorth / quota : 0;
  const band = ratio >= 3 ? '3x' : ratio >= 2 ? '2x' : ratio >= 1 ? 'break-even' : 'pre-even';
  const offset = GRID_BANDS.indexOf(band);
  return {
    ratio, band,
    strategies: [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)],
  };
}

export default function SeasonPieceEntry({
  profile, earnings = 0, onUpdate, onStartWeek, onNavigate, busy = false,
  showEarnings = false, compact = false, onHide,
}) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const tradesEarnings = Number(earnings) || 0;
  const currentWorth = Math.max(0, (Number(profile.balance) || 0) + tradesEarnings);
  const grid = strategyGrid(profile, currentWorth);
  const messages = Array.isArray(profile.pieceMessages) ? profile.pieceMessages : [];
  const selected = profile.selectionStrategy || 'standard';

  async function sendMessage(event) {
    event.preventDefault();
    const content = message.trim();
    if (!content || !onUpdate || saving) return;
    const nextMessages = [...messages, { id: Date.now() + '-' + profile.id, role: 'user', content, createdAt: new Date().toISOString() }];
    setSaving(true);
    try {
      await onUpdate(profile, { pieceMessages: nextMessages, piecePrompt: content });
      setMessage('');
    } finally { setSaving(false); }
  }

  return <article className={`season-piece-card ${profile.activePlayer === false ? 'season-inactive' : ''} ${compact ? 'season-piece-card-compact' : ''}`}>
    {onHide && <button className="remove-piece-btn" title="Remove piece from this graph" onClick={() => onHide(profile)}><X size={14}/></button>}
    <div className="season-piece-art"><SeasonToken pieceType={profile.pieceType} baseColor={profile.baseColor} size={compact ? 76 : 92}/></div>
    <div className="season-piece-info">
      <b>{profile.name}</b>
      <span>Season {profile.season} · {profile.paperMode ? 'Paper' : 'Live'} · {profile.activePlayer === false ? 'Inactive' : 'Active'}</span>
      <strong>{money(currentWorth)} {showEarnings ? 'current worth' : 'piece worth'}</strong>
      <small>{profile.pieceType} · {profile.baseName} base · {profile.strategy || 'midpoint'} ladder</small>
      <small>Quota {money(profile.quotaValue ?? profile.balance)} · {showEarnings ? money(tradesEarnings) + ' earned' : 'Next: ' + (profile.nextScheduledWeek || 'week1')}</small>
      {profile.selectedLines?.[0] && <small className="season-piece-selected-game">Strategy pick: {profile.selectedLines[0].team || profile.selectedLines[0].event || profile.selectedLines[0].ticker} · {profile.selectedLines[0].league || 'Market'} · {profile.selectedLines[0].line ?? 'ladder'} · {profile.selectedLines[0].side}</small>}
      {profile.activePlayer !== false && <div className="season-piece-controls">
        <button className="secondary-btn" disabled={busy} onClick={() => onStartWeek?.(profile)}>Start next week</button>
        <button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button>
        <button className="secondary-btn piece-expand-button" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button>
      </div>}
      {profile.activePlayer === false && <div className="season-piece-controls"><button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button><button className="secondary-btn" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button></div>}
      {expanded && <div className="season-piece-expanded">
        <div className="season-piece-grid-panel">
          <div className="season-piece-section-title">Strategy graph · {grid.band} · {grid.ratio.toFixed(2)}× quota</div>
          <label className="piece-axis-control">Risk · top axis
            <select value={profile.riskPreference || 'probability'} onChange={(e) => onUpdate?.(profile, { riskPreference: e.target.value })}>
              <option value="probability">Probability first · strict</option><option value="balanced">Balanced</option><option value="value">Value first · lenient</option>
            </select>
          </label>
          <div className="piece-grid-horizontal">
            {GRID_BANDS.map((band) => <span key={band} className={'piece-grid-band ' + (grid.band === band ? 'active' : '')}>{band === 'pre-even' ? 'Pre-even' : band === 'break-even' ? 'Breaking even' : band}</span>)}
          </div>
          <div className="piece-strategy-buttons">
            {grid.strategies.map((strategy) => <button key={strategy.id} className={`secondary-btn ${selected === strategy.id ? 'active' : ''}`} onClick={() => onUpdate?.(profile, { selectionStrategy: strategy.id })}>{strategy.label}</button>)}
          </div>
          <label className="piece-axis-control">Diversity · bottom axis
            <select value={profile.diversityMode || 'allow-overlap'} onChange={(e) => onUpdate?.(profile, { diversityMode: e.target.value })}>
              <option value="allow-overlap">Allow same games</option><option value="avoid-overlap">Avoid other pieces' games</option><option value="split">Prefer diversified selection</option>
            </select>
          </label>
          <label className="piece-safe-control"><input type="checkbox" checked={!!profile.safe} onChange={(e) => onUpdate?.(profile, { safe: e.target.checked })}/> Safe strategy (disables Value)</label>
          <div className="season-piece-strategy-note">
            {STRATEGIES.find((item) => item.id === selected)?.probability == null
              ? 'Baseball: original strict NO-only eligibility rules.'
              : `Minimum model probability ${STRATEGIES.find((item) => item.id === selected).probability}% · payout above ${STRATEGIES.find((item) => item.id === selected).payout}.`}
          </div>
        </div>
        <div className="season-piece-chat">
          <div className="season-piece-section-title"><MessageCircle size={14}/> Instructions to this piece</div>
          <div className="season-piece-chat-history">
            {messages.length ? messages.map((item) => <div className="season-piece-chat-message" key={item.id}><small>{new Date(item.createdAt).toLocaleString()}</small><p>{item.content}</p></div>) : <div className="season-piece-chat-empty">Send this piece an instruction, question, or matchup factor to investigate. Messages are saved inside this piece.</div>}
          </div>
          <form onSubmit={sendMessage} className="season-piece-chat-compose">
            <textarea rows="2" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message this season piece…"/>
            <button className="primary-btn" type="submit" disabled={!message.trim() || saving}><Send size={14}/> {saving ? 'Saving…' : 'Send'}</button>
          </form>
        </div>
      </div>}
    </div>
  </article>;
}
