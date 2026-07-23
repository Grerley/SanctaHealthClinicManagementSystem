import { useEffect, useState } from 'react';
import { ConnectivityIndicator } from '@sancta/ui';
import { Dispense } from './screens/Dispense.tsx';
import { Patients } from './screens/Patients.tsx';
import { Queue } from './screens/Queue.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Calendar } from './screens/Calendar.tsx';
import { Chart } from './screens/Chart.tsx';
import { Encounter } from './screens/Encounter.tsx';
import { Prescribe } from './screens/Prescribe.tsx';
import { Vitals } from './screens/Vitals.tsx';
import { Orders } from './screens/Orders.tsx';
import { Finance } from './screens/Finance.tsx';
import { Inbox } from './screens/Inbox.tsx';
import { Inventory } from './screens/Inventory.tsx';
import { Cashier } from './screens/Cashier.tsx';
import { PatientBanner } from './PatientBanner.tsx';
import type { Patient } from './api.ts';
import './shell.css';

type Tab = 'dispense' | 'inbox' | 'patients' | 'chart' | 'encounter' | 'prescribe' | 'vitals' | 'orders' | 'queue' | 'calendar' | 'inventory' | 'cashier' | 'finance' | 'dashboard';
// Role-ordered primary navigation (§4.1). The app opens on Dispense & Pay (the
// flagship slice); Inbox ("Today": critical results & tasks) sits alongside it.
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'dispense', label: 'Dispense & Pay', hint: 'Pharmacy and cashier' },
  { id: 'inbox', label: 'Inbox', hint: 'Critical results & tasks' },
  { id: 'patients', label: 'Patients', hint: 'Search and registration' },
  { id: 'chart', label: 'Chart', hint: 'Clinical record' },
  { id: 'encounter', label: 'Encounter', hint: 'Document and sign' },
  { id: 'prescribe', label: 'Prescribe', hint: 'Medication and allergy check' },
  { id: 'vitals', label: 'Vitals', hint: 'Triage observations' },
  { id: 'orders', label: 'Orders', hint: 'Labs, imaging, referrals' },
  { id: 'queue', label: 'Queue', hint: 'Reception and flow' },
  { id: 'calendar', label: 'Calendar', hint: 'Appointments' },
  { id: 'inventory', label: 'Inventory', hint: 'Stock and expiry' },
  { id: 'cashier', label: 'Cashier', hint: 'Shift close and drawer' },
  { id: 'finance', label: 'Finance', hint: 'Debtors and ledger' },
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
          {tab === 'inbox' && <Inbox />}
          {tab === 'patients' && <Patients onSelect={setActivePatient} />}
          {tab === 'chart' && <Chart patient={activePatient} />}
          {tab === 'encounter' && <Encounter patient={activePatient} />}
          {tab === 'prescribe' && <Prescribe patient={activePatient} />}
          {tab === 'vitals' && <Vitals patient={activePatient} />}
          {tab === 'orders' && <Orders patient={activePatient} />}
          {tab === 'queue' && <Queue />}
          {tab === 'calendar' && <Calendar />}
          {tab === 'inventory' && <Inventory />}
          {tab === 'cashier' && <Cashier />}
          {tab === 'finance' && <Finance />}
          {tab === 'dashboard' && <Dashboard />}
        </div>
      </main>
    </div>
  );
}
