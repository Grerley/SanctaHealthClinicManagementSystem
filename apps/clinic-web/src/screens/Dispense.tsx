import { useCallback, useEffect, useState } from 'react';
import { api, type Patient } from '../api.ts';

const SKU = 'AMOX-500';

export function Dispense() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<string>('');
  const [onHand, setOnHand] = useState<number | null>(null);
  const [pending, setPending] = useState<number>(0);
  const [qty, setQty] = useState<number>(10);
  const [charge, setCharge] = useState<number>(500);
  const [payment, setPayment] = useState<number>(300);
  const [message, setMessage] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.stock(SKU), api.syncStatus()]);
      setOnHand(s.onHand);
      setPending(st.pending);
    } catch {
      /* offline shown by the banner */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.patients();
        setPatients(p.patients);
        if (p.patients[0]) setPatientId(p.patients[0].id);
      } catch {
        setMessage('Working offline — patient list loads when the edge is reachable.');
      }
      await refresh();
    })();
  }, [refresh]);

  const doCheckout = async () => {
    if (!patientId) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await api.checkout({ patientId, sku: SKU, quantity: qty, chargeMinor: charge, paymentMinor: payment, paymentMethod: 'cash' });
      if (res.ok) setMessage(`Saved locally. Receipt issued. Invoice ${res.invoiceId?.slice(-8)}. Queued for sync.`);
      else if (res.duplicate) setMessage('This dispense was already recorded (duplicate prevented).');
      await refresh();
    } catch {
      setMessage('Could not save. The edge hub may be unreachable — please retry.');
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await api.syncPush();
      setMessage(r.acknowledged > 0 ? `Synchronised ${r.acknowledged} change(s) to the cloud.` : r.failed > 0 ? 'Sync could not reach the cloud — changes remain safely queued.' : 'Nothing to synchronise.');
      await refresh();
    } catch {
      setMessage('Sync could not reach the cloud — changes remain safely queued.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: 12, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <span data-testid="stock">Stock {SKU}: <strong>{onHand ?? '—'}</strong></span>
        <span data-testid="sync-badge">{pending > 0 ? <>Pending sync: <strong>{pending}</strong></> : <>All synced</>}</span>
      </div>

      <label style={{ display: 'block', margin: '12px 0 8px' }}>
        Patient
        <select data-testid="patient" value={patientId} onChange={(e) => setPatientId(e.target.value)} style={{ display: 'block', width: '100%', padding: 6 }}>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>{p.family_name}, {p.given_name} ({p.mrn})</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>Quantity<input data-testid="qty" type="number" value={qty} min={1} onChange={(e) => setQty(Number(e.target.value))} style={{ display: 'block', width: 100, padding: 6 }} /></label>
        <label>Charge (cents)<input data-testid="charge" type="number" value={charge} min={0} onChange={(e) => setCharge(Number(e.target.value))} style={{ display: 'block', width: 120, padding: 6 }} /></label>
        <label>Payment (cents)<input data-testid="payment" type="number" value={payment} min={0} onChange={(e) => setPayment(Number(e.target.value))} style={{ display: 'block', width: 120, padding: 6 }} /></label>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button data-testid="checkout" disabled={busy || !patientId} onClick={doCheckout} style={{ padding: '8px 14px', background: '#0b5', color: '#fff', border: 0, borderRadius: 6 }}>Dispense &amp; take payment</button>
        <button data-testid="sync" disabled={busy} onClick={syncNow} style={{ padding: '8px 14px', background: '#334155', color: '#fff', border: 0, borderRadius: 6 }}>Sync now</button>
      </div>
      <p data-testid="message" role="status" aria-live="polite" style={{ marginTop: 12, minHeight: 20 }}>{message}</p>
    </section>
  );
}
