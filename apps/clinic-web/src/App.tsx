import { useEffect, useState } from 'react';
import { ConnectivityIndicator } from '@sancta/ui';
import { Dispense } from './screens/Dispense.tsx';
import { Patients } from './screens/Patients.tsx';
import { Queue } from './screens/Queue.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Calendar } from './screens/Calendar.tsx';
import { Chart } from './screens/Chart.tsx';
import { PatientBanner } from './PatientBanner.tsx';
import type { Patient } from './api.ts';
import './shell.css';

type Tab = 'dispense' | 'patients' | 'chart' | 'queue' | 'calendar' | 'dashboard';
// Role-ordered primary navigation (§4.1).
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'dispense', label: 'Dispense & Pay', hint: 'Pharmacy and cashier' },
  { id: 'patients', label: 'Patients', hint: 'Search and registration' },
  { id: 'chart', label: 'Chart', hint: 'Clinical record' },
  { id: 'queue', label: 'Queue', hint: 'Reception and flow' },
  { id: 'calendar', label: 'Calendar', hint: 'Appointments' },
  { id: 'dashboard', label: 'Command centre', hint: 'Management' },
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

  const activeTab = TABS.find((t) => t.id === tab)!;

  return (
    <div className="shell">
      {/* §4.2 Global header — product identity + connectivity. */}
      <header className="shell__header">
        <div className="shell__brand">
          <h1>Sancta Clinic</h1>
          <span className="shell__site">Main clinic</span>
        </div>
        <div className="shell__conn" data-testid="net-status">
          {online
            ? <ConnectivityIndicator clinicReachable cloudReachable pendingCount={0} />
            : <span className="shell__offline">Offline — local work continues on this device</span>}
        </div>
      </header>

      {/* §4.2 Primary navigation — stable, role-ordered destinations. */}
      <nav className="shell__nav" role="tablist" aria-label="Primary">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="shell__tab sancta-focusable"
            data-testid={`tab-${t.id}`}
            data-active={tab === t.id || undefined}
            onClick={() => setTab(t.id)}
          >
            <span className="shell__tab-label">{t.label}</span>
            <span className="shell__tab-hint">{t.hint}</span>
          </button>
        ))}
      </nav>

      <main className="shell__main">
        {/* §4.2 Context strip — persistent patient identity during risky work. */}
        <PatientBanner patient={activePatient} online={online} />

        {/* §4.2 Page header — one title + short context. */}
        <div className="shell__page-header">
          <h2>{activeTab.label}</h2>
          <span className="shell__page-context">{activeTab.hint}</span>
        </div>

        {/* §4.2 Work area. */}
        <div className="shell__work">
          {tab === 'dispense' && <Dispense />}
          {tab === 'patients' && <Patients onSelect={setActivePatient} />}
          {tab === 'chart' && <Chart patient={activePatient} />}
          {tab === 'queue' && <Queue />}
          {tab === 'calendar' && <Calendar />}
          {tab === 'dashboard' && <Dashboard />}
        </div>
      </main>
    </div>
  );
}
