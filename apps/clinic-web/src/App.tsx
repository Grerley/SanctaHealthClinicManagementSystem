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
import { Results } from './screens/Results.tsx';
import { Mar } from './screens/Mar.tsx';
import { Handover } from './screens/Handover.tsx';
import { Referrals } from './screens/Referrals.tsx';
import { Documents } from './screens/Documents.tsx';
import { CarePlans } from './screens/CarePlans.tsx';
import { Devices } from './screens/Devices.tsx';
import { Comms } from './screens/Comms.tsx';
import { Finance } from './screens/Finance.tsx';
import { Inbox } from './screens/Inbox.tsx';
import { Inventory } from './screens/Inventory.tsx';
import { Cashier } from './screens/Cashier.tsx';
import { PatientBanner } from './PatientBanner.tsx';
import type { Patient } from './api.ts';
import './shell.css';

type Tab = 'dispense' | 'inbox' | 'patients' | 'chart' | 'encounter' | 'prescribe' | 'vitals' | 'orders' | 'results' | 'mar' | 'careplans' | 'referrals' | 'documents' | 'handover' | 'queue' | 'calendar' | 'inventory' | 'cashier' | 'finance' | 'comms' | 'devices' | 'dashboard';
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
  { id: 'results', label: 'Results', hint: 'Enter and classify results' },
  { id: 'mar', label: 'Med round', hint: 'Administer medications' },
  { id: 'careplans', label: 'Care plans', hint: 'Goals and follow-ups' },
  { id: 'referrals', label: 'Referrals', hint: 'Refer to other facilities' },
  { id: 'documents', label: 'Documents', hint: 'Upload and find files' },
  { id: 'handover', label: 'Handover', hint: 'SBAR shift handover' },
  { id: 'queue', label: 'Queue', hint: 'Reception and flow' },
  { id: 'calendar', label: 'Calendar', hint: 'Appointments' },
  { id: 'inventory', label: 'Inventory', hint: 'Stock and expiry' },
  { id: 'cashier', label: 'Cashier', hint: 'Shift close and drawer' },
  { id: 'finance', label: 'Finance', hint: 'Debtors and ledger' },
  { id: 'comms', label: 'Comms', hint: 'Messages and replies' },
  { id: 'devices', label: 'Devices', hint: 'Trust and revocation' },
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
          {tab === 'results' && <Results />}
          {tab === 'mar' && <Mar />}
          {tab === 'careplans' && <CarePlans patient={activePatient} />}
          {tab === 'referrals' && <Referrals patient={activePatient} />}
          {tab === 'documents' && <Documents patient={activePatient} />}
          {tab === 'handover' && <Handover />}
          {tab === 'queue' && <Queue />}
          {tab === 'calendar' && <Calendar />}
          {tab === 'inventory' && <Inventory />}
          {tab === 'cashier' && <Cashier />}
          {tab === 'finance' && <Finance />}
          {tab === 'comms' && <Comms />}
          {tab === 'devices' && <Devices />}
          {tab === 'dashboard' && <Dashboard />}
        </div>
      </main>
    </div>
  );
}
