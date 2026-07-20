import { useCallback, useEffect, useState } from 'react';
import { api, type Patient, type QueueRow } from '../api.ts';

export function Queue() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try { setRows((await api.queue()).queue); } catch { /* offline */ }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.patients();
        setPatients(p.patients);
        if (p.patients[0]) setPatientId(p.patients[0].id);
      } catch { /* offline */ }
      await refresh();
    })();
  }, [refresh]);

  const checkIn = async () => {
    if (!patientId) return;
    try {
      const r = await api.startVisit(patientId, 'reception');
      setMessage(`Checked in — queue token ${r.token}.`);
      await refresh();
    } catch {
      setMessage('Could not check in — the edge hub may be unreachable.');
    }
  };

  return (
    <section>
      <h2 style={{ fontSize: 16 }}>Check in</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select data-testid="queue-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)} style={{ padding: 6 }}>
          {patients.map((p) => (<option key={p.id} value={p.id}>{p.family_name}, {p.given_name} ({p.mrn})</option>))}
        </select>
        <button data-testid="checkin" disabled={!patientId} onClick={checkIn} style={{ padding: '8px 14px', background: '#0b5', color: '#fff', border: 0, borderRadius: 6 }}>Check in</button>
        <button data-testid="queue-refresh" onClick={refresh} style={{ padding: '8px 14px' }}>Refresh</button>
      </div>
      <p data-testid="queue-message" role="status" aria-live="polite" style={{ minHeight: 20 }}>{message}</p>

      <h2 style={{ fontSize: 16, marginTop: 12 }}>Queue board</h2>
      <table data-testid="queue-board" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left' }}><th>Token</th><th>Station</th><th>MRN</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.visitId} style={{ borderTop: '1px solid #eee' }}>
              <td><strong>{r.token}</strong></td><td>{r.station}</td><td>{r.patientMrn}</td><td>{r.status}</td>
            </tr>
          ))}
          {rows.length === 0 && (<tr><td colSpan={4} style={{ color: '#888', padding: 8 }}>Queue is empty.</td></tr>)}
        </tbody>
      </table>
    </section>
  );
}
