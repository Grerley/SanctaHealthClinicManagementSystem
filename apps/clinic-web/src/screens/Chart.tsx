import { useEffect, useMemo, useState } from 'react';
import { StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type TimelineItem, type HistoryItem } from '../api.ts';
import './screens.css';

type TypeFilter = 'all' | TimelineItem['type'];
const TYPE_LABEL: Record<TimelineItem['type'], string> = { encounter: 'Encounter', addendum: 'Addendum', observation: 'Observation', result: 'Result' };
const TYPE_TONE: Record<TimelineItem['type'], 'info' | 'neutral' | 'action'> = { encounter: 'action', addendum: 'neutral', observation: 'info', result: 'info' };

/**
 * Patient chart — summary + longitudinal timeline (EHR-01, EHR-02). Read-only:
 * every item is derived from its source record with provenance (who/when), and a
 * critical result is visibly distinguished from a merely abnormal one (§3.1). The
 * chart only opens with a patient in context (the identity strip stays visible).
 */
export function Chart({ patient }: { patient: Patient | null }) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!patient) { setState('ready'); return; }
    setState('loading');
    void (async () => {
      try {
        const [h, t] = await Promise.all([api.ehrHistory(patient.id), api.timeline(patient.id)]);
        setHistory(h.history);
        setTimeline(t.timeline);
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, [patient]);

  const shown = useMemo(
    () => (filter === 'all' ? timeline : timeline.filter((i) => i.type === filter)).slice().sort((a, b) => b.at.localeCompare(a.at)),
    [timeline, filter],
  );
  const problems = history.filter((h) => h.category === 'problem' && h.status === 'active');

  if (!patient) {
    return <StateBlock state="permission-limited" title="No patient in context">Select a patient from the Patients screen to open their chart.</StateBlock>;
  }
  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading chart">Fetching the record from the clinic hub…</StateBlock>;
  if (state === 'error') return <StateBlock state="stale" title="Chart unavailable">The clinic hub may be unreachable. The record could not be loaded.</StateBlock>;

  return (
    <section className="scr" data-testid="chart" aria-label={`Chart for ${patient.given_name} ${patient.family_name}`}>
      <div>
        <h3 className="scr__section-title">Active problems</h3>
        {problems.length === 0
          ? <StateBlock state="empty" title="No active problems recorded" />
          : (
            <ul className="scr__list" data-testid="chart-problems">
              {problems.map((p) => (
                <li key={p.id}><div className="scr__list-btn" style={{ cursor: 'default', display: 'flex', gap: 'var(--sancta-space-2)', alignItems: 'center' }}>
                  <strong>{p.detail}</strong>{p.code ? <StatusTag tone="neutral">{p.code}</StatusTag> : null}
                  {p.onsetDate ? <span className="scr__kpi-meta">since {p.onsetDate}</span> : null}
                </div></li>
              ))}
            </ul>
          )}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Clinical timeline</h3>
          <span className="scr__seg" role="group" aria-label="Filter timeline by type">
            {(['all', 'encounter', 'observation', 'result'] as TypeFilter[]).map((t) => (
              <button key={t} data-testid={`chart-filter-${t}`} className="scr__seg-btn sancta-focusable" aria-pressed={filter === t} onClick={() => setFilter(t)}>
                {t === 'all' ? 'All' : TYPE_LABEL[t as TimelineItem['type']]}
              </button>
            ))}
          </span>
        </div>

        {shown.length === 0
          ? <StateBlock state={filter === 'all' ? 'empty' : 'filtered-empty'} title={filter === 'all' ? 'No clinical events yet' : 'No events of this type'} />
          : (
            <ol className="scr__list" data-testid="chart-timeline">
              {shown.map((i) => {
                const critical = i.flags?.includes('critical');
                return (
                  <li key={`${i.type}-${i.id}`}>
                    <div className="scr__list-btn" style={{ cursor: 'default', display: 'flex', gap: 'var(--sancta-space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <StatusTag tone={TYPE_TONE[i.type]}>{TYPE_LABEL[i.type]}</StatusTag>
                      <span style={{ flex: 1, minWidth: 160 }}>{i.summary}</span>
                      {critical ? <StatusTag tone="danger" icon="alert">Critical</StatusTag>
                        : i.flags && i.flags.length > 0 ? <StatusTag tone="warning">{i.flags.join(', ')}</StatusTag> : null}
                      <span className="scr__kpi-meta" data-numeric>{i.at.slice(0, 16).replace('T', ' ')}{i.author ? ` · ${i.author}` : ''}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
      </div>
    </section>
  );
}
