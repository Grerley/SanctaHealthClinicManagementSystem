import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type CalendarEntry } from '../api.ts';
import './screens.css';

type ViewMode = 'day' | 'week';
type GroupBy = 'provider' | 'room' | 'service';

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeOf(iso: string): string {
  // Display HH:MM from the ISO instant (UTC — the API stores/returns UTC).
  return iso.slice(11, 16);
}

const GROUP_LABEL: Record<GroupBy, string> = { provider: 'Provider', room: 'Room', service: 'Service' };

function keyFor(e: CalendarEntry, by: GroupBy): string {
  const v = by === 'provider' ? e.provider : by === 'room' ? e.room : e.serviceCode;
  return v ?? 'Unassigned';
}

/**
 * Appointment calendar (APT-01). Day/week views, groupable by provider/room/service.
 * The grid is a labelled horizontal scroller so a week never forces page scroll
 * (§6.3). DOM contract preserved for the e2e suite.
 */
export function Calendar() {
  const today = new Date().toISOString().slice(0, 10);
  const [anchor, setAnchor] = useState<string>(today);
  const [view, setView] = useState<ViewMode>('day');
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [status, setStatus] = useState<string>('');

  const range = useMemo(() => {
    const from = anchor;
    const to = view === 'week' ? addDays(anchor, 6) : anchor;
    return { from, to };
  }, [anchor, view]);

  const load = useCallback(async () => {
    try {
      const r = await api.calendar(range.from, range.to);
      setEntries(r.entries);
      setStatus(`${r.entries.length} slot(s) — ${view === 'week' ? 'week' : 'day'} of ${range.from}`);
    } catch {
      setStatus('Calendar unavailable — the clinic hub may be unreachable.');
    }
  }, [range, view]);

  useEffect(() => { void load(); }, [load]);

  const days = useMemo(() => {
    const n = view === 'week' ? 7 : 1;
    return Array.from({ length: n }, (_, i) => addDays(range.from, i));
  }, [range.from, view]);

  const grouped = useMemo(() => {
    const byDay = new Map<string, Map<string, CalendarEntry[]>>();
    for (const e of entries) {
      const g = byDay.get(e.day) ?? new Map<string, CalendarEntry[]>();
      const k = keyFor(e, groupBy);
      const list = g.get(k) ?? [];
      list.push(e);
      g.set(k, list);
      byDay.set(e.day, g);
    }
    return byDay;
  }, [entries, groupBy]);

  return (
    <section className="scr" data-testid="calendar" aria-label="Appointment calendar">
      <div className="scr__toolbar">
        <label className="sancta-field" style={{ maxWidth: 180 }}>
          <span className="sancta-field__label">Date</span>
          <input data-testid="calendar-date" className="sancta-field-input" type="date" aria-label="Calendar date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
        </label>
        <button data-testid="calendar-prev" className="scr__seg-btn sancta-focusable" aria-label="Previous period" onClick={() => setAnchor(addDays(anchor, view === 'week' ? -7 : -1))}>◀ Prev</button>
        <button data-testid="calendar-next" className="scr__seg-btn sancta-focusable" aria-label="Next period" onClick={() => setAnchor(addDays(anchor, view === 'week' ? 7 : 1))}>Next ▶</button>

        <span className="scr__seg" role="group" aria-label="View mode">
          {(['day', 'week'] as ViewMode[]).map((v) => (
            <button key={v} data-testid={`view-${v}`} className="scr__seg-btn sancta-focusable" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </span>

        <span className="scr__seg" role="group" aria-label="Group by">
          {(['provider', 'room', 'service'] as GroupBy[]).map((g) => (
            <button key={g} data-testid={`group-${g}`} className="scr__seg-btn sancta-focusable" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}>
              {GROUP_LABEL[g]}
            </button>
          ))}
        </span>
      </div>

      <p className="scr__msg" data-testid="calendar-status" role="status" aria-live="polite">{status}</p>

      <div data-testid="calendar-grid" className="scr__cal" style={{ gridTemplateColumns: view === 'week' ? 'repeat(7, minmax(120px, 1fr))' : '1fr' }}>
        {days.map((day) => {
          const groups = grouped.get(day);
          return (
            <div key={day} data-testid={`calendar-day-${day}`} className="scr__cal-day">
              <h3>{day}</h3>
              {!groups && <p className="scr__kpi-meta">No slots.</p>}
              {groups && [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => (
                <div key={k} data-testid={`calendar-group-${k}`} className="scr__cal-group">
                  <div className="scr__cal-group-name">{k}</div>
                  {list.map((e) => (
                    <div key={e.slotId} data-testid="calendar-slot" className="scr__cal-slot" data-booked={e.status === 'booked' ? 'true' : undefined}>
                      {timeOf(e.startsAt)}–{timeOf(e.endsAt)} · {e.status}
                      {e.patientMrn ? ` · ${e.patientMrn}` : ''}
                      {groupBy !== 'room' && e.room ? ` · ${e.room}` : ''}
                      {groupBy !== 'service' && e.serviceCode ? ` · ${e.serviceCode}` : ''}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
