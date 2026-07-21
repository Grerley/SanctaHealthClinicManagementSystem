import { useEffect, useState } from 'react';
import { Dispense } from './screens/Dispense.tsx';
import { Patients } from './screens/Patients.tsx';
import { Queue } from './screens/Queue.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Calendar } from './screens/Calendar.tsx';
import { PatientBanner } from './PatientBanner.tsx';
import type { Patient } from './api.ts';

type Tab = 'dispense' | 'patients' | 'queue' | 'calendar' | 'dashboard';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dispense', label: 'Dispense & Pay' },
  { id: 'patients', label: 'Patients' },
  { id: 'queue', label: 'Queue' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'dashboard', label: 'Command centre' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('dispense');
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [activePatient, setActivePatient] = useState<Patient | null>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 820, margin: '0 auto', padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>Sancta Clinic</h1>
        <span data-testid="net-status" style={{ padding: '2px 8px', borderRadius: 12, background: online ? '#dcfce7' : '#fee2e2', color: online ? '#065f46' : '#991b1b', fontSize: 13 }}>
          {online ? 'Online' : 'Offline — local work continues'}
        </span>
      </header>

      <PatientBanner patient={activePatient} online={online} />

      <nav role="tablist" style={{ display: 'flex', gap: 4, margin: '12px 0', borderBottom: '1px solid #e5e7eb' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            style={{ padding: '8px 12px', border: 0, borderBottom: tab === t.id ? '2px solid #047857' : '2px solid transparent', background: 'transparent', fontWeight: tab === t.id ? 700 : 400, cursor: 'pointer' }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'dispense' && <Dispense />}
      {tab === 'patients' && <Patients onSelect={setActivePatient} />}
      {tab === 'queue' && <Queue />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'dashboard' && <Dashboard />}
    </main>
  );
}
