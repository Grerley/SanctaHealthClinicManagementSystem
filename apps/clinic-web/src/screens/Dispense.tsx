import { useCallback, useEffect, useState } from 'react';
import { Button, Field, StatusTag } from '@sancta/ui';
import { api, type Patient } from '../api.ts';
import './screens.css';

const SKU = 'AMOX-500';

/**
 * Dispense & take payment (MED-05 / BIL-04) — the flagship vertical slice. One
 * confirmed local commit yields the stock movement, invoice and payment together
 * (§3.3, BR-008). Money uses a permanent currency adornment + tabular figures; the
 * sync badge and status message state honestly what is saved and what is waiting to
 * sync (§10). The DOM contract is preserved for the e2e suite.
 */
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
      /* offline is shown by the connectivity indicator + patient strip */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.patients();
        setPatients(p.patients);
        if (p.patients[0]) setPatientId(p.patients[0].id);
      } catch {
        setMessage('Working offline — patient list loads when the clinic hub is reachable.');
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
      setMessage('Could not save. The clinic hub may be unreachable — please retry.');
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
    <section className="scr">
      <div className="scr__row" style={{ alignItems: 'center' }}>
        <span className="scr__card" data-testid="stock">Stock {SKU}: <strong data-numeric>{onHand ?? '—'}</strong></span>
        <span data-testid="sync-badge">
          {pending > 0
            ? <StatusTag tone="warning" icon="cloud-off">{`Pending sync: ${pending}`}</StatusTag>
            : <StatusTag tone="success" icon="check">All synced</StatusTag>}
        </span>
      </div>

      <label className="sancta-field">
        <span className="sancta-field__label">Patient</span>
        <select data-testid="patient" className="sancta-field-input" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>{p.family_name}, {p.given_name} ({p.mrn})</option>
          ))}
        </select>
      </label>

      <div className="scr__row">
        <Field label="Quantity" numeric data-testid="qty" value={qty} min={1} onChange={(e) => setQty(Number(e.currentTarget.value))} style={{ maxWidth: 120 }} />
        <Field label="Charge" numeric prefix="¢" hint="In cents" data-testid="charge" value={charge} min={0} onChange={(e) => setCharge(Number(e.currentTarget.value))} style={{ maxWidth: 160 }} />
        <Field label="Payment" numeric prefix="¢" hint="In cents" data-testid="payment" value={payment} min={0} onChange={(e) => setPayment(Number(e.currentTarget.value))} style={{ maxWidth: 160 }} />
      </div>

      <div className="scr__row">
        <Button variant="primary" data-testid="checkout" disabled={busy || !patientId} onClick={doCheckout}>Dispense &amp; take payment</Button>
        <Button variant="secondary" data-testid="sync" disabled={busy} onClick={syncNow}>Sync now</Button>
      </div>

      <p className="scr__msg" data-testid="message" role="status" aria-live="polite">{message}</p>
    </section>
  );
}
