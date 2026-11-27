import React, { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { readActivity } from '../lib/dataModel';

const TONE = { SEASON_START: 'ok', WEEK_START: 'ok', TRADE_RECORDED: 'wait', ERROR: 'bad' };
const VISIBLE_TYPES = new Set(['SEASON_START', 'WEEK_START', 'TRADE_RECORDED', 'ERROR']);

export default function LatestActivity({ dataFolder, filter, onFilterChange }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!dataFolder?.handle) { setEvents([]); return; }
      setLoading(true); setError('');
      try {
        const list = await readActivity(dataFolder.handle, 60);
        if (!cancelled) setEvents(list.filter((ev) => VISIBLE_TYPES.has(ev.type)));
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not read activity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dataFolder]);

  const shown = useMemo(() => {
    if (!filter || filter === 'all') return events;
    if (filter === 'paper') return events.filter((ev) => ev.type !== 'TRADE_RECORDED' || /paper/i.test(ev.message));
    if (filter === 'live') return events.filter((ev) => ev.type !== 'TRADE_RECORDED' || /live/i.test(ev.message));
    return events;
  }, [events, filter]);

  return (
    <section className="panel bottom-panel">
      <div className="panel-heading">
        <div><h2>Latest activity</h2><p>Season, week, and trade events</p></div>
        <div className="segmented">
          {['all', 'paper', 'live'].map((f) => (
            <button
              key={f}
              className={`seg-btn ${(filter || 'all') === f ? 'active' : ''}`}
              onClick={() => onFilterChange?.(f)}
            >{f === 'all' ? 'All' : f === 'paper' ? 'Paper' : 'Live'}</button>
          ))}
        </div>
      </div>

      {!dataFolder?.handle && (
        <div className="empty-state">
          <div className="empty-icon"><Clock3 size={22}/></div>
          <b>Connect a data folder</b>
          <span>Activity is read from your local data folder once it's connected.</span>
        </div>
      )}

      {dataFolder?.handle && loading && <div className="empty-state"><span>Loading activity…</span></div>}
      {dataFolder?.handle && !loading && error && <div className="empty-state"><b>Activity unavailable</b><span>{error}</span></div>}
      {dataFolder?.handle && !loading && !error && shown.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon"><Clock3 size={22}/></div>
          <b>No activity recorded</b>
          <span>Season, week, and trade events will appear here.</span>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="activity-list">
          {shown.map((ev, i) => (
            <li className="activity-row" key={`${ev.timestamp}-${i}`}>
              <span className={`activity-dot ${TONE[ev.type] || 'wait'}`} />
              <div>
                <b>{ev.message}</b>
                <small>{ev.type} · {new Date(ev.timestamp).toLocaleString()}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}