import React, { useState } from 'react';
import { MessageCircle, Send, ChevronDown, CalendarDays, X } from 'lucide-react';
import SeasonToken from './SeasonToken';

const GRID_BANDS = [
  { id: 'pre-even', label: 'Pre-even' },
  { id: 'break-even', label: 'Breaking even' },
  { id: '2x', label: '2x' },
  { id: '3x', label: '3x' },
];
const STRATEGIES = [
  { id: 'standard', label: 'Standard', probability: 92, payout: '1.20×' },
  { id: 'value', label: 'Value', probability: 84, payout: '1.40×' },
  { id: 'highroller', label: 'High Roller', probability: 70, payout: '1.75×' },
];
const money = (value) => '$' + (Number(value) || 0).toFixed(2);

function strategyGrid(profile, currentWorth) {
  const quota = Math.max(0, Number(profile.quotaValue ?? profile.balance) || 0);
  const ratio = quota > 0 ? currentWorth / quota : 0;
  const band = ratio >= 3 ? '3x' : ratio >= 2 ? '2x' : ratio >= 1 ? 'break-even' : 'pre-even';
  const offset = GRID_BANDS.findIndex((item) => item.id === band);
  return { ratio, band, strategies: [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)] };
}

export default function SeasonPieceEntry({ profile, earnings = 0, onUpdate, onStartWeek, onNavigate, busy = false, compact = false, onHide }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const currentWorth = Math.max(0, (Number(profile.balance) || 0) + (Number(earnings) || 0));
  const grid = strategyGrid(profile, currentWorth);
  const messages = Array.isArray(profile.pieceMessages) ? profile.pieceMessages : [];
  const selected = profile.selectionStrategy || '';
  const ready = Boolean(selected);

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

  const chooseStrategy = (strategy) => onUpdate?.(profile, { selectionStrategy: selected === strategy ? '' : strategy });
  const chooseBand = (band) => onUpdate?.(profile, { gridBand: band });

  return <article className={`season-piece-card ${profile.activePlayer === false ? 'season-inactive' : ''} ${compact ? 'season-piece-card-compact' : ''}`}>
    {onHide && <button className="remove-piece-btn" title="Remove piece from this graph" onClick={() => onHide(profile)}><X size={14}/></button>}
    <div className="season-piece-art"><SeasonToken pieceType={profile.pieceType} baseColor={profile.baseColor} size={compact ? 76 : 92}/></div>
    <div className="season-piece-info">
      <b>{profile.name}</b>
      <span>Season {profile.season} · {profile.paperMode ? 'Paper' : 'Live'} · {profile.activePlayer === false ? 'Inactive' : 'Active'}</span>
      <strong>{money(currentWorth)} current worth</strong>
      <small>{profile.pieceType} · {profile.baseName} base · {profile.strategy || 'midpoint'} ladder</small>
      <small>Quota {money(profile.quotaValue ?? profile.balance)} · {money(earnings)} earned</small>
      <small>Next scheduled: {profile.nextScheduledWeek || 'week1'}</small>
      {!ready && <div className="piece-not-ready" role="status">NOT READY FOR PLAY · SELECT A STRATEGY</div>}
      {ready && profile.selectedLines?.[0] && <small className="season-piece-selected-game">Selected game: {profile.selectedLines[0].team || profile.selectedLines[0].event || profile.selectedLines[0].ticker} · {profile.selectedLines[0].league || 'Market'} · {profile.selectedLines[0].line ?? 'ladder'} · {profile.selectedLines[0].side}</small>}
      {profile.activePlayer !== false && <div className="season-piece-controls">
        <button className="secondary-btn" disabled={busy || !ready} onClick={() => onStartWeek?.(profile)}>Start next week</button>
        <button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button>
        <button className="secondary-btn piece-expand-button" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button>
      </div>}
      {profile.activePlayer === false && <div className="season-piece-controls"><button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button><button className="secondary-btn" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button></div>}
      {expanded && <div className="season-piece-expanded">
        <div className="season-piece-grid-panel">
          <div className="season-piece-section-title">Strategy Graph</div>
          <div className="piece-strategy-buttons">
            {grid.strategies.map((strategy) => <button key={strategy.id} className={`piece-strategy-button ${selected === strategy.id ? 'is-selected' : 'is-unset'}`} aria-pressed={selected === strategy.id} onClick={() => chooseStrategy(strategy.id)}>{strategy.label}</button>)}
          </div>
          <button className={`piece-strategy-button piece-baseball-button ${selected === 'baseball-no' ? 'is-selected' : 'is-unset'}`} aria-pressed={selected === 'baseball-no'} onClick={() => chooseStrategy('baseball-no')}>Bet NO Strat (Baseball)</button>
          <div className="piece-grid-horizontal">
            {GRID_BANDS.map((band) => <button type="button" key={band.id} className={`piece-grid-band-button ${grid.band === band.id ? 'active' : ''}`} aria-pressed={grid.band === band.id} onClick={() => chooseBand(band.id)}>{band.label}</button>)}
          </div>
          <label className="piece-axis-control">Risk
            <select value={profile.riskPreference || 'probability'} onChange={(e) => onUpdate?.(profile, { riskPreference: e.target.value })}>
              <option value="probability">Probability first</option><option value="balanced">Balanced</option><option value="value">Value first</option>
            </select>
          </label>
          <div className="piece-strategy-note">{ready ? 'Selected: ' + (selected === 'baseball-no' ? 'Bet NO Strat (Baseball only)' : STRATEGIES.find((item) => item.id === selected)?.label) : 'Strategy selection required.'}</div>
        </div>
        <div className="season-piece-chat">
          <div className="season-piece-section-title"><MessageCircle size={14}/> Instructions to this piece</div>
          <div className="season-piece-chat-history">
            {messages.map((item) => <div className="season-piece-chat-message" key={item.id}><small>{new Date(item.createdAt).toLocaleString()}</small><p>{item.content}</p></div>)}
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
