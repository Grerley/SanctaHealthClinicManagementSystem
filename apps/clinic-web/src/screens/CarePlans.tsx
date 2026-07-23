import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type CarePlan } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';
const FUP_TONE: Record<string, 'warning' | 'success' | 'neutral'> = { open: 'warning', done: 'success', cancelled: 'neutral' };

/**
 * Care plans (EHR-006). A longitudinal plan for the patient in context — goals with
 * target dates and dated follow-ups that stay OPEN until completed, so nothing owed
 * to the patient is lost between visits (overdue follow-ups also surface on the
 * management work queue). Every mutation is a confirmed-commit write (§9.2). Loads
 * the patient's plans on open; with no patient in context it does no fetch and
 * guides the user to pick one. Uses /api/ehr/care-plan* — matching paths on both
 * the edge and the Worker; the read is scoped by the patient's own UUID.
 */
export function CarePlans({ patient }: { patient: Patient | null }) {
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const [title, setTitle] = useState('');
  const [goalDraft, setGoalDraft] = useState<Record<string, { description: string; targetDate: string }>>({});
  const [fupDraft, setFupDraft] = useState<Record<string, { description: string; dueDate: string }>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!patient) return;
    const r = await api.carePlans(patient.id);
    setPlans(r.carePlans);
  }, [patient]);

  useEffect(() => {
    if (!patient) { setState('idle'); return; }
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [patient, load]);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to view or build a care plan.</StateBlock>;
  }
  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading care plans" />;
  if (state === 'error') return <StateBlock state="stale" title="Care plans unavailable">The clinic hub may be unreachable.</StateBlock>;

  const runWrite = async (url: string, body: unknown, okText: string): Promise<boolean> => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(url, body, { idempotencyKey: newIdempotencyKey() });
    setBusy(false);
    if (res.ok) { setMsg({ tone: 'success', text: okText }); try { await load(); } catch { /* covered */ } return true; }
    setMsg({ tone: 'danger', text: res.errorCode === 'network' ? 'Could not reach the clinic hub — nothing was saved; your entry is kept.' : `Could not save (${res.errorCode ?? 'error'}). Your entry is kept.` });
    return false;
  };

  const createPlan = async () => {
    if (!title.trim()) return;
    if (await runWrite('/api/ehr/care-plan', { patientId: patient.id, title: title.trim(), user: USER }, 'Care plan created.')) setTitle('');
  };
  const addGoal = async (planId: string) => {
    const d = goalDraft[planId]; if (!d?.description.trim()) return;
    if (await runWrite('/api/ehr/care-plan/goal', { carePlanId: planId, description: d.description.trim(), ...(d.targetDate ? { targetDate: d.targetDate } : {}) }, 'Goal added.'))
      setGoalDraft((s) => ({ ...s, [planId]: { description: '', targetDate: '' } }));
  };
  const addFup = async (planId: string) => {
    const d = fupDraft[planId]; if (!d?.description.trim() || !d.dueDate) return;
    if (await runWrite('/api/ehr/care-plan/followup', { carePlanId: planId, description: d.description.trim(), dueDate: d.dueDate }, 'Follow-up scheduled.'))
      setFupDraft((s) => ({ ...s, [planId]: { description: '', dueDate: '' } }));
  };
  const completeFup = (id: string) => runWrite('/api/ehr/care-plan/followup/complete', { id, user: USER }, 'Follow-up completed.');

  const gd = (id: string) => goalDraft[id] ?? { description: '', targetDate: '' };
  const fd = (id: string) => fupDraft[id] ?? { description: '', dueDate: '' };

  return (
    <section className="scr" aria-label="Care plans">
      <div className="scr__card" data-testid="cp-create">
        <h3 className="scr__section-title">New care plan (EHR-06)</h3>
        <p className="scr__kpi-meta">For {patient.given_name} {patient.family_name}.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Plan title" hint="e.g. Hypertension management" data-testid="cp-title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} style={{ minWidth: 280 }} />
          <Button variant="primary" data-testid="cp-create-btn" disabled={busy} {...(!title.trim() ? { disabledReason: 'Enter a plan title' } : {})} onClick={createPlan}>Create plan</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {plans.length === 0
        ? <StateBlock state="empty" title="No care plans yet">Create the first plan above to set goals and follow-ups.</StateBlock>
        : plans.map((plan) => (
          <div key={plan.id} className="scr__card" data-testid="cp-plan">
            <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
              <h3 className="scr__section-title">{plan.title}</h3>
              <StatusTag tone={plan.status === 'active' ? 'info' : 'neutral'}>{plan.status}</StatusTag>
            </div>

            <h4 className="scr__kpi-label" style={{ marginTop: 'var(--sancta-space-2)' }}>Goals</h4>
            {plan.goals.length === 0
              ? <p className="scr__kpi-meta">No goals yet.</p>
              : <ul className="scr__addenda">{plan.goals.map((g, i) => (
                  <li key={i} className="scr__kpi-meta">{g.description}{g.targetDate ? ` · target ${g.targetDate}` : ''} <StatusTag tone="neutral">{g.status}</StatusTag></li>
                ))}</ul>}
            <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
              <Field label="Add goal" hint="Description" data-testid="cp-goal-desc" value={gd(plan.id).description} onChange={(e) => setGoalDraft((s) => ({ ...s, [plan.id]: { ...gd(plan.id), description: e.currentTarget.value } }))} />
              <Field label="Target" optional type="date" data-testid="cp-goal-date" value={gd(plan.id).targetDate} onChange={(e) => setGoalDraft((s) => ({ ...s, [plan.id]: { ...gd(plan.id), targetDate: e.currentTarget.value } }))} />
              <Button variant="secondary" density="compact" data-testid="cp-goal-add" disabled={busy} {...(!gd(plan.id).description.trim() ? { disabledReason: 'Describe the goal' } : {})} onClick={() => addGoal(plan.id)}>Add goal</Button>
            </div>

            <h4 className="scr__kpi-label" style={{ marginTop: 'var(--sancta-space-3)' }}>Follow-ups</h4>
            {plan.followUps.length === 0
              ? <p className="scr__kpi-meta">No follow-ups scheduled.</p>
              : <ul className="scr__addenda">{plan.followUps.map((f) => (
                  <li key={f.id} className="scr__row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="scr__kpi-meta">{f.description} · due {f.dueDate} <StatusTag tone={FUP_TONE[f.status] ?? 'neutral'}>{f.status}</StatusTag></span>
                    {f.status === 'open' && <Button variant="subtle" density="compact" data-testid="cp-fup-complete" disabled={busy} onClick={() => completeFup(f.id)}>Complete</Button>}
                  </li>
                ))}</ul>}
            <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
              <Field label="Add follow-up" hint="Description" data-testid="cp-fup-desc" value={fd(plan.id).description} onChange={(e) => setFupDraft((s) => ({ ...s, [plan.id]: { ...fd(plan.id), description: e.currentTarget.value } }))} />
              <Field label="Due" type="date" data-testid="cp-fup-date" value={fd(plan.id).dueDate} onChange={(e) => setFupDraft((s) => ({ ...s, [plan.id]: { ...fd(plan.id), dueDate: e.currentTarget.value } }))} />
              <Button variant="secondary" density="compact" data-testid="cp-fup-add" disabled={busy}
                {...(!fd(plan.id).description.trim() || !fd(plan.id).dueDate ? { disabledReason: 'Describe the follow-up and set a due date' } : {})} onClick={() => addFup(plan.id)}>Schedule</Button>
            </div>
          </div>
        ))}
    </section>
  );
}
