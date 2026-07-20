import { useEffect, useState } from 'react';
import { api, type Kpi, type Exception } from '../api.ts';

export function Dashboard() {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.dashboard();
        setKpis(d.kpis);
        setExceptions(d.exceptions);
      } catch {
        setError('Dashboard unavailable offline.');
      }
    })();
  }, []);

  return (
    <section>
      <h2 style={{ fontSize: 16 }}>Exceptions</h2>
      <div data-testid="dash-exceptions">
        {exceptions.length === 0 ? (
          <p style={{ color: '#047857' }}>No open exceptions.</p>
        ) : (
          <ul style={{ paddingLeft: 18 }}>
            {exceptions.map((e) => (
              <li key={e.type} style={{ marginBottom: 4 }}>
                <strong style={{ color: '#b45309' }}>{e.count}</strong> {e.label} <span style={{ color: '#595959' }}>· {e.owner}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 style={{ fontSize: 16, marginTop: 16 }}>Key indicators</h2>
      <div data-testid="dash-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
        {kpis.map((k) => (
          <div key={k.id} title={k.formula} style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: '#595959' }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{k.value}</div>
            <div style={{ fontSize: 11, color: '#595959' }}>{k.unit} · {k.owner}</div>
          </div>
        ))}
      </div>
      {error && <p role="status" style={{ color: '#a00' }}>{error}</p>}
    </section>
  );
}
