import React, { useEffect, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { readAllRecords } from '../lib/dataModel';

export default function PredictionHistory({ dataFolder, refreshKey }) {
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  async function load() {
    if (!dataFolder?.handle) { setRecords([]); return; }
    try { setError(''); setRecords(await readAllRecords(dataFolder.handle)); }
    catch (e) { setError(e.message || 'Could not load prediction history'); }
  }
  useEffect(() => { load(); }, [dataFolder, refreshKey]);
  return <div className="page-shell">
    <div className="page-heading">
      <div><div className="eyebrow">ARCHIVE</div><h1>Prediction History</h1><p>Scanner-qualified candidates, final matchup interrogations, and recorded predictions.</p></div>
      <button className="secondary-btn" onClick={load}><RefreshCw size={14}/> Refresh</button>
    </div>
    {error && <div className="notice error-notice"><b>{error}</b></div>}
    {!records.length ? <div className="empty-state panel"><History size={22}/><b>No prediction history yet</b><span>Qualified candidates and recorded predictions will appear here.</span></div> :
      <section className="panel">
        <div className="table-wrap"><table>
          <thead><tr><th>DATE</th><th>PIECE</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>BASELINE</th><th>FINAL REVIEW</th><th>STATUS</th></tr></thead>
          <tbody>{records.map((r) => <tr key={r.id}>
            <td>{r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}</td>
            <td>{r.seasonPieceId || '—'}</td>
            <td>{r.matchup || '—'}</td>
            <td>{r.market || '—'}</td>
            <td>{r.side || '—'}</td>
            <td>{r.modelProbability == null ? (r.probability == null ? '—' : r.probability + '%') : Math.round(Number(r.modelProbability) * 100) + '%'}</td>
            <td>{r.finalVerdict ? <span className="status-pill">{r.finalVerdict}{r.finalProbabilityYes == null ? '' : ' · YES ' + Math.round(Number(r.finalProbabilityYes) * 100) + '%'}</span> : 'Not interrogated'}</td>
            <td><span className="status-pill">{r.status || 'open'}</span></td>
          </tr>)}</tbody>
        </table></div>
        <div className="table-foot"><span>Qualified candidates are review records, not placed trades.</span><span>{records.length} entries</span></div>
      </section>}
  </div>;
}
