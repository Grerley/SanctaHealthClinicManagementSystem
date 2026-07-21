import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type CalendarEntry } from '../api.ts';

type ViewMode = 'day' | 'week';
type GroupBy = 'provider' | 'room' | 'service';

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeOf(iso: string): string {
  // Display HH:MM from the ISO instant (UTC — the edge stores/returns UTC).
  return iso.slice(11, 16);
}

const GROUP_LABEL: Record<GroupBy, string> = { provider: 'Provider', room: 'Room', service: 'Service' };

function keyFor(e: CalendarEntry, by: GroupBy): string {
  const v = by === 'provider' ? e.provider : by === 'room' ? e.room : e.serviceCode;
  return v ?? 'Unassigned';
}

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
      setStatus('Calendar unavailable — the edge hub may be unreachable.');
    }
  }, [range, view]);

  useEffect(() => { void load(); }, [load]);

  // Days spanning the current view.
  const days = useMemo(() => {
    const n = view === 'week' ? 7 : 1;
    return Array.from({ length: n }, (_, i) => addDays(range.from, i));
  }, [range.from, view]);

  // entries grouped: day -> group key -> entries.
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
    <section data-testid="calendar" aria-label="Appointment calendar">
      <h2 style={{ fontSize: 16 }}>Appointment calendar</h2>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        <label style={{ fontSize: 13 }}>
          Date{' '}
          <input data-testid="calendar-date" type="date" aria-label="Calendar date" value={anchor} onChange={(e) => setAnchor(e.target.value)} style={{ padding: 4 }} />
        </label>
        <button data-testid="calendar-prev" aria-label="Previous period" onClick={() => setAnchor(addDays(anchor, view === 'week' ? -7 : -1))} style={{ padding: '6px 10px' }}>◀</button>
        <button data-testid="calendar-next" aria-label="Next period" onClick={() => setAnchor(addDays(anchor, view === 'week' ? 7 : 1))} style={{ padding: '6px 10px' }}>▶</button>

        <span role="group" aria-label="View mode" style={{ display: 'inline-flex', gap: 4 }}>
          {(['day', 'week'] as ViewMode[]).map((v) => (
            <button key={v} data-testid={`view-${v}`} aria-pressed={view === v} onClick={() => setView(v)}
              style={{ padding: '6px 10px', fontWeight: view === v ? 700 : 400, background: view === v ? '#047857' : '#f3f4f6', color: view === v ? '#fff' : '#111', border: 0, borderRadius: 6 }}>
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </span>

        <span role="group" aria-label="Group by" style={{ display: 'inline-flex', gap: 4 }}>
          {(['provider', 'room', 'service'] as GroupBy[]).map((g) => (
            <button key={g} data-testid={`group-${g}`} aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}
              style={{ padding: '6px 10px', fontWeight: groupBy === g ? 700 : 400, background: groupBy === g ? '#e0f2fe' : '#f3f4f6', border: 0, borderRadius: 6 }}>
              {GROUP_LABEL[g]}
            </button>
          ))}
        </span>
      </div>

      <p data-testid="calendar-status" role="status" aria-live="polite" style={{ fontSize: 13, color: '#595959', minHeight: 18 }}>{status}</p>

      <div data-testid="calendar-grid" style={{ display: 'grid', gridTemplateColumns: view === 'week' ? 'repeat(7, minmax(120px, 1fr))' : '1fr', gap: 8, overflowX: 'auto' }}>
        {days.map((day) => {
          const groups = grouped.get(day);
          return (
            <div key={day} data-testid={`calendar-day-${day}`} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, minWidth: 0 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>{day}</h3>
              {!groups && <p style={{ color: '#595959', fontSize: 12 }}>No slots.</p>}
              {groups && [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => (
                <div key={k} data-testid={`calendar-group-${k}`} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{k}</div>
                  {list.map((e) => (
                    <div key={e.slotId} data-testid="calendar-slot" style={{ fontSize: 12, padding: '2px 4px', borderLeft: `3px solid ${e.status === 'booked' ? '#047857' : '#9ca3af'}`, marginTop: 2 }}>
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
