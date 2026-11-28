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
          <thead><tr><th>DATE</th><th>PIECE</th><th>MATCHUP</th><th>MARKET</th><th>SIDE</th><th>BASELINE</th><th>FINAL REVIEW</th><th>MOTIVATION</th><th>MATCHUP NOTES</th><th>STATUS</th></tr></thead>
          <tbody>{records.map((r) => <tr key={r.id}>
            <td>{r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}</td>
            <td>{r.seasonPieceId || '—'}</td>
            <td>{r.matchup || '—'}</td>
            <td>{r.market || '—'}</td>
            <td>{r.side || '—'}</td>
            <td>{r.modelProbability == null ? (r.probability == null ? '—' : r.probability + '%') : Math.round(Number(r.modelProbability) * 100) + '%'}</td>
            <td>{r.finalVerdict ? <span className="status-pill">{r.finalVerdict}{r.finalSideProbability == null ? '' : ' · side ' + Math.round(Number(r.finalSideProbability) * 100) + '%'}</span> : 'Not interrogated'}</td>
            <td>{r.motivationAssessment || r.finalInterrogation?.interrogation?.motivationAssessment
              ? <div style={{minWidth:220,maxWidth:340,whiteSpace:'normal'}}>
                  <b>{Number(r.motivationAdjustmentPoints ?? r.finalInterrogation?.interrogation?.motivationAdjustmentPoints ?? 0) > 0 ? '+' : ''}{Number(r.motivationAdjustmentPoints ?? r.finalInterrogation?.interrogation?.motivationAdjustmentPoints ?? 0)} pp</b>
                  <p>{r.motivationAssessment || r.finalInterrogation?.interrogation?.motivationAssessment}</p>
                </div>
              : 'Not recorded'}</td>
            <td>{r.finalInterrogation?.interrogation ? <details><summary>View defense / injury review</summary><div style={{minWidth:260,maxWidth:420,whiteSpace:'normal'}}>
              <b>Motivation:</b> {r.finalInterrogation.interrogation.motivationAssessment || 'Not recorded'}
              <p><b>Defense:</b> {r.finalInterrogation.interrogation.defensiveAssessment || 'Not supplied'}
              <p><b>Opponent points allowed:</b> {r.finalInterrogation.evidence?.opponentDefense?.defense?.seasonPointsAllowed == null ? 'Unavailable' : Number(r.finalInterrogation.evidence.opponentDefense.defense.seasonPointsAllowed).toFixed(1) + ' season / ' + (r.finalInterrogation.evidence.opponentDefense.defense.recentPointsAllowed == null ? 'N/A' : Number(r.finalInterrogation.evidence.opponentDefense.defense.recentPointsAllowed).toFixed(1) + ' recent 10') + ' · sample ' + r.finalInterrogation.evidence.opponentDefense.defense.gamesSampled}</p>
              <p><b>Defensive injuries:</b> {(r.finalInterrogation.interrogation.defensiveInjuries || []).join('; ') || (r.finalInterrogation.evidence?.opponentDefense?.injuries || []).map((item) => item.player + ' (' + item.status + ')').join('; ') || 'None reported'}</p>
              <p><b>Offensive availability:</b> {r.finalInterrogation.interrogation.offensiveAvailability || 'Not supplied'}</p>
              <p><b>Reasoning:</b> {(r.finalInterrogation.interrogation.reasoning || []).join(' ')}</p>
              <p><b>Risks:</b> {(r.finalInterrogation.interrogation.risks || []).join(' ') || 'None reported'}</p>
              <p><b>Missing data:</b> {(r.finalInterrogation.interrogation.missingData || []).join(' ') || 'None reported'}</p>
            </div></details> : '—'}</td>
            <td><span className="status-pill">{r.status || 'open'}</span></td>
          </tr>)}</tbody>
        </table></div>
        <div className="table-foot"><span>Qualified candidates are review records, not placed trades.</span><span>{records.length} entries</span></div>
      </section>}
  </div>;
}
