import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectivityIndicator } from '@sancta/ui';
import { PatientBanner } from './PatientBanner.tsx';
import { ScreenErrorBoundary } from './ScreenErrorBoundary.tsx';
import { Login } from './Login.tsx';
import type { Patient } from './api.ts';
import { MODULES, SCREENS, screensOf } from './registry/index.ts';
import { MODULE_ACCENT, type Persona } from './personas.ts';
import { currentPersona, signIn, signOut } from './session.ts';
import './shell.css';

export function App() {
  const [persona, setPersona] = useState<Persona | null>(() => currentPersona());
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [activePatient, setActivePatient] = useState<Patient | null>(null);
  const [activeId, setActiveId] = useState<string>(() => currentPersona()?.home ?? 'dispense');

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

  // Modules this persona works in, in the persona's own order (Administrator: all).
  const modules = useMemo(() => {
    if (!persona) return [];
    if (persona.modules === 'all') return MODULES.filter((m) => screensOf(m.id).length > 0);
    return persona.modules
      .map((id) => MODULES.find((m) => m.id === id))
      .filter((m): m is (typeof MODULES)[number] => !!m && screensOf(m.id).length > 0);
  }, [persona]);

  if (!persona) {
    return (
      <Login
        onSignIn={(p) => {
          signIn(p.id);
          setPersona(p);
          setActiveId(p.home);
          setActivePatient(null);
        }}
      />
    );
  }

  // Only screens inside the persona's modules are reachable; clamp the active screen.
  const visibleModuleIds = new Set(modules.map((m) => m.id));
  const visible = SCREENS.filter((s) => visibleModuleIds.has(s.moduleId));
  const active =
    visible.find((s) => s.id === activeId) ??
    visible.find((s) => s.id === persona.home) ??
    visible[0] ??
    SCREENS[0]!;
  const activeModule = MODULES.find((m) => m.id === active.moduleId);

  const leave = () => {
    signOut();
    setPersona(null);
    setActivePatient(null);
  };

  return (
    <div className="shell">
      {/* §4.2 Global top bar — product identity, connectivity, current persona. Slim so
          the workspace, not the chrome, owns the screen. */}
      <header className="shell__topbar">
        <div className="shell__brand">
          <span className="shell__mark" aria-hidden="true">S</span>
          <h1>Sancta Clinic</h1>
          <span className="shell__site">Main clinic</span>
        </div>
        <div className="shell__topbar-right">
          <div className="shell__conn" data-testid="net-status">
            {online
              ? <ConnectivityIndicator clinicReachable cloudReachable pendingCount={0} />
              : <span className="shell__offline">Offline — local work continues on this device</span>}
          </div>
          <div className="shell__persona" style={{ '--persona-accent': persona.accent } as CSSProperties}>
            <span className="shell__persona-avatar" aria-hidden="true">{persona.label.slice(0, 1)}</span>
            <span className="shell__persona-label">{persona.label}</span>
            <button type="button" className="shell__signout sancta-focusable" data-testid="sign-out" onClick={leave}>
              Switch role
            </button>
          </div>
        </div>
      </header>

      <div className="shell__body">
        {/* §4.2 Primary navigation — persona-scoped, grouped by module, in a left rail.
            Every screen stays a single click away. */}
        <nav className="shell__nav" aria-label="Primary">
          {modules.map((m) => {
            const screens = screensOf(m.id);
            const accent = MODULE_ACCENT[m.id] ?? 'var(--sancta-colour-action)';
            return (
              <div key={m.id} className="shell__navgroup" role="group" aria-label={m.label}>
                <span className="shell__navgroup-label">
                  <span className="shell__badge" aria-hidden="true" style={{ background: accent }}>{m.label.slice(0, 1)}</span>
                  {m.label}
                </span>
                <div className="shell__navgroup-tabs">
                  {screens.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="shell__tab sancta-focusable"
                      data-testid={`tab-${s.id}`}
                      data-active={active.id === s.id || undefined}
                      aria-current={active.id === s.id ? 'page' : undefined}
                      style={{ '--persona-accent': accent } as CSSProperties}
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

        <main className="shell__content">
          {/* §4.4 Context strip — persistent patient identity during risky work. */}
          <PatientBanner patient={activePatient} online={online} />

          {/* §4.2 Page header — one title + short context. */}
          <div className="shell__page-header">
            <h2>{active.label}</h2>
            <span className="shell__page-context">{activeModule ? `${activeModule.label} · ` : ''}{active.hint}</span>
          </div>

          {/* §4.2 Work area — the active screen. The boundary is keyed by the active
              screen so a fault in one screen never white-screens the shell. */}
          <div className="shell__work">
            <ScreenErrorBoundary key={active.id}>
              {active.render({ patient: activePatient, setPatient: setActivePatient })}
            </ScreenErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
