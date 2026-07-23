import { useEffect, useState } from 'react';
import { ConnectivityIndicator } from '@sancta/ui';
import { PatientBanner } from './PatientBanner.tsx';
import { ScreenErrorBoundary } from './ScreenErrorBoundary.tsx';
import type { Patient } from './api.ts';
import { MODULES, SCREENS, screensOf } from './registry/index.ts';
import './shell.css';

export function App() {
  const [activeId, setActiveId] = useState<string>('dispense');
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

  const active = SCREENS.find((s) => s.id === activeId) ?? SCREENS[0]!;
  const activeModule = MODULES.find((m) => m.id === active.moduleId);

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

      {/* §4.2 Primary navigation — role-ordered modules, each grouping its screens.
          Every screen tab stays in the DOM so any destination is one click away. */}
      <nav className="shell__nav" aria-label="Primary">
        {MODULES.map((m) => {
          const screens = screensOf(m.id);
          if (screens.length === 0) return null;
          return (
            <div key={m.id} className="shell__navgroup" role="group" aria-label={m.label}>
              <span className="shell__navgroup-label">{m.label}</span>
              <div className="shell__navgroup-tabs">
                {screens.map((s) => (
                  <button
                    key={s.id}
                    className="shell__tab sancta-focusable"
                    data-testid={`tab-${s.id}`}
                    data-active={activeId === s.id || undefined}
                    aria-current={activeId === s.id ? 'page' : undefined}
                    onClick={() => setActiveId(s.id)}
                  >
                    <span className="shell__tab-label">{s.label}</span>
                    <span className="shell__tab-hint">{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <main className="shell__main">
        {/* §4.2 Context strip — persistent patient identity during risky work. */}
        <PatientBanner patient={activePatient} online={online} />

        {/* §4.2 Page header — one title + short context. */}
        <div className="shell__page-header">
          <h2>{active.label}</h2>
          <span className="shell__page-context">{activeModule ? `${activeModule.label} · ` : ''}{active.hint}</span>
        </div>

        {/* §4.2 Work area — the active screen, rendered from the registry. The boundary
            is keyed by the active screen so a fault in one screen never white-screens the
            shell, and moving to another screen clears the error. */}
        <div className="shell__work">
          <ScreenErrorBoundary key={active.id}>
            {active.render({ patient: activePatient, setPatient: setActivePatient })}
          </ScreenErrorBoundary>
        </div>
      </main>
    </div>
  );
}
