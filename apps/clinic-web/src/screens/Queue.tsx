import { useCallback, useEffect, useState } from 'react';
import { Button } from '@sancta/ui';
import { api, type Patient, type QueueRow } from '../api.ts';
import './screens.css';

/**
 * Reception check-in + live queue board (REC-01/02/04). Check-in issues a token and
 * the board reflects across devices within seconds. The board is an accessible table
 * (caption + column scope) inside a horizontal scroller so it never forces page
 * scroll. DOM contract preserved for the e2e suite.
 */
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
      setMessage('Could not check in — the clinic hub may be unreachable.');
    }
  };

  return (
    <section className="scr">
      <div>
        <h3 className="scr__section-title">Check in</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <label className="sancta-field" style={{ minWidth: 240 }}>
            <span className="sancta-field__label">Patient</span>
            <select data-testid="queue-patient" className="sancta-field-input" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
              {patients.map((p) => (<option key={p.id} value={p.id}>{p.family_name}, {p.given_name} ({p.mrn})</option>))}
            </select>
          </label>
          <Button variant="primary" data-testid="checkin" disabled={!patientId} onClick={checkIn}>Check in</Button>
          <Button variant="subtle" data-testid="queue-refresh" onClick={refresh}>Refresh</Button>
        </div>
        <p className="scr__msg" data-testid="queue-message" role="status" aria-live="polite">{message}</p>
      </div>

      <div>
        <h3 className="scr__section-title">Queue board</h3>
        <div className="scr__table-scroll">
          <table data-testid="queue-board" className="scr__table">
            <caption className="sancta-visually-hidden">Patients currently in the clinic queue</caption>
            <thead><tr><th scope="col">Token</th><th scope="col">Station</th><th scope="col">Clinic no.</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.visitId}>
                  <td data-numeric><strong>{r.token}</strong></td><td>{r.station}</td><td data-numeric>{r.patientMrn}</td><td>{r.status}</td>
                </tr>
              ))}
              {rows.length === 0 && (<tr><td colSpan={4} style={{ color: 'var(--sancta-colour-text-secondary)' }}>Queue is empty.</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
