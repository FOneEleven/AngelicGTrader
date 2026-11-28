import React, { useState } from 'react';
import { MessageCircle, Send, ChevronDown, CalendarDays, X } from 'lucide-react';
import SeasonToken from './SeasonToken';

const WORTH_CONDITIONS = [
  { id: 'pre-even', label: 'Pre-even', min: 0, max: 1 },
  { id: 'break-even', label: 'Breaking even', min: 1, max: 2 },
  { id: '2x', label: '2x', min: 2, max: 3 },
  { id: '3x', label: '3x', min: 3, max: Infinity },
];
const STRATEGIES = [
  { id: 'standard', label: 'Standard' },
  { id: 'value', label: 'Value' },
  { id: 'highroller', label: 'High Roller' },
];
const RISK_OPTIONS = [
  { id: 'probability', label: 'Probability first' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'value', label: 'Value first' },
];
const money = (value) => '$' + (Number(value) || 0).toFixed(2);

function getWorthState(profile, currentWorth) {
  const original = Math.max(0, Number(profile.quotaValue ?? profile.initialBalance ?? profile.balance) || 0);
  const ratio = original > 0 ? currentWorth / original : 0;
  const condition = ratio >= 3 ? '3x' : ratio >= 2 ? '2x' : ratio >= 1 ? 'break-even' : 'pre-even';
  return { original, ratio, condition };
}

export default function SeasonPieceEntry({ profile, earnings = 0, onUpdate, onStartWeek, onNavigate, busy = false, compact = false, onHide }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const currentWorth = Math.max(0, Number(earnings) || 0);
  const worth = getWorthState(profile, currentWorth);
  const strategiesByCondition = profile.strategiesByWorthCondition || {};
  const riskByCondition = profile.riskByWorthCondition || {};
  const activeStrategy = strategiesByCondition[worth.condition] || (profile.selectionStrategy && profile.selectionStrategy !== 'baseball-no' ? profile.selectionStrategy : '');
  const baseballEnabled = profile.baseballNoStrategy === true || profile.selectionStrategy === 'baseball-no';
  const activeRisk = riskByCondition[worth.condition] || '';
  const ready = Boolean(activeStrategy && activeRisk);
  const inPlayBox = profile.selectedLines?.[0]?.playBoxStatus === 'in-play-box';
  const pendingResolution = profile.selectedLines?.[0]?.playBoxStatus === 'committed' && profile.selectionResolution?.status === 'committed';
  const messages = Array.isArray(profile.pieceMessages) ? profile.pieceMessages : [];

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

  function chooseStrategy(condition, strategy) {
    const next = { ...strategiesByCondition, [condition]: strategiesByCondition[condition] === strategy ? '' : strategy };
    onUpdate?.(profile, { strategiesByWorthCondition: next });
  }
  function chooseRisk(condition, risk) {
    onUpdate?.(profile, { riskByWorthCondition: { ...riskByCondition, [condition]: risk } });
  }

  return <article className={`season-piece-card ${profile.activePlayer === false ? 'season-inactive' : ''} ${compact ? 'season-piece-card-compact' : ''}`}>
    {onHide && <button className="remove-piece-btn" title="Remove piece from this graph" onClick={() => onHide(profile)}><X size={14}/></button>}
    <div className="season-piece-art"><SeasonToken pieceType={profile.pieceType} baseColor={profile.baseColor} size={compact ? 76 : 92}/></div>
    <div className="season-piece-info">
      <b>{profile.name}</b>
      <span>Season {profile.season} · {profile.paperMode ? 'Paper' : 'Live'} · {profile.activePlayer === false ? 'Inactive' : 'Active'}</span>
      <strong>{money(currentWorth)} current worth</strong>
      <small>Original allocation {money(worth.original)} · {money(currentWorth)} confirmed wallet returns · {worth.ratio.toFixed(2)}×</small>
      <small>{profile.pieceType} · {profile.baseName} base · {profile.strategy || 'midpoint'} ladder</small>
      <small>Next scheduled: {profile.nextScheduledWeek || 'week1'}</small>
      {!ready && <div className="piece-not-ready" role="status">NOT READY FOR PLAY · SET STRATEGY AND RISK FOR {WORTH_CONDITIONS.find((x) => x.id === worth.condition)?.label.toUpperCase()}</div>}
      {profile.selectedLines?.[0] && <small className="season-piece-selected-game">Selected game: {profile.selectedLines[0].team || profile.selectedLines[0].event || profile.selectedLines[0].ticker} · {profile.selectedLines[0].league || 'Market'} · {profile.selectedLines[0].line ?? 'ladder'} · {profile.selectedLines[0].side} · {profile.selectedLines[0].playBoxStatus === 'in-play-box' ? 'IN PLAY BOX' : profile.selectedLines[0].playBoxStatus === 'committed' ? 'COMMITTED' : 'SELECTED'}</small>}
      {profile.activePlayer !== false && <div className="season-piece-controls">
        <button className="secondary-btn" disabled={busy || !ready || inPlayBox || pendingResolution} onClick={() => onStartWeek?.(profile)}>{inPlayBox ? 'In Play Box' : pendingResolution ? 'Match pending' : 'Start next week'}</button>
        <button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button>
        <button className="secondary-btn piece-expand-button" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button>
      </div>}
      {profile.activePlayer === false && <div className="season-piece-controls"><button className="secondary-btn" onClick={() => onNavigate?.('Game Day')}><CalendarDays size={13}/> Go To Gameday</button><button className="secondary-btn" onClick={() => setExpanded((value) => !value)}><ChevronDown size={13}/> {expanded ? 'Close piece' : 'Open piece'}</button></div>}
      {expanded && <div className="season-piece-expanded">
        <div className="season-piece-grid-panel">
          <div className="season-piece-section-title">Strategy Graph</div>
          <div className="piece-worth-graph">
            {WORTH_CONDITIONS.map((condition) => {
              const selectedStrategy = strategiesByCondition[condition.id] || (condition.id === worth.condition && profile.selectionStrategy && profile.selectionStrategy !== 'baseball-no' ? profile.selectionStrategy : '');
              const selectedRisk = riskByCondition[condition.id] || (condition.id === worth.condition ? profile.riskPreference : '');
              return <section className={`piece-worth-column ${condition.id === worth.condition ? 'is-current' : ''}`} key={condition.id}>
                <button type="button" className={`piece-grid-band-button ${condition.id === worth.condition ? 'active' : ''}`} aria-current={condition.id === worth.condition ? 'step' : undefined}>{condition.label}</button>
                <div className="piece-worth-strategies">
                  {STRATEGIES.map((strategy) => <button key={strategy.id} className={`piece-strategy-button ${selectedStrategy === strategy.id ? 'is-selected' : 'is-unset'}`} aria-pressed={selectedStrategy === strategy.id} onClick={() => chooseStrategy(condition.id, strategy.id)}>{strategy.label}</button>)}
                </div>
                <label className="piece-axis-control">Risk
                  <select value={selectedRisk || ''} onChange={(e) => chooseRisk(condition.id, e.target.value)}>
                    <option value="" disabled>Set risk</option>
                    {RISK_OPTIONS.map((risk) => <option key={risk.id} value={risk.id}>{risk.label}</option>)}
                  </select>
                </label>
                <small className="piece-worth-status">{selectedStrategy && selectedRisk ? 'Configured' : 'Not configured'}</small>
              </section>;
            })}
          </div>
          <div className="piece-baseball-row">
            <span>Bet NO Strat (Baseball)</span>
            <button type="button" className={`piece-strategy-button ${baseballEnabled ? 'is-selected' : 'is-unset'}`} aria-pressed={baseballEnabled} onClick={() => onUpdate?.(profile, { baseballNoStrategy: !baseballEnabled })}>{baseballEnabled ? 'Enabled' : 'Disabled'}</button>
          </div>
          <div className="piece-strategy-note">The active worth condition is determined automatically from current piece value divided by its original value. Baseball uses its own strict NO strategy whenever enabled.</div>
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
