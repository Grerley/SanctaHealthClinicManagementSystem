import type { CSSProperties } from 'react';
import { PERSONAS, type Persona } from './personas.ts';

/**
 * Sign-in (spec §5.1). On a shared, device-bound clinic install, signing in is choosing
 * WHO is at the device this shift — which scopes the workspace and the RBAC roles. No
 * password here: a real deployment binds this to an authenticated, device-bound session.
 */
export function Login({ onSignIn }: { onSignIn: (persona: Persona) => void }) {
  return (
    <div className="login">
      <div className="login__panel">
        <header className="login__head">
          <div className="login__brand">
            <span className="login__mark" aria-hidden="true">S</span>
            <div>
              <h1 className="login__title">Sancta Clinic</h1>
              <p className="login__sub">Clinic management · Main clinic</p>
            </div>
          </div>
          <p className="login__lead">Choose your role to open your workspace.</p>
        </header>

        <ul className="login__grid" role="list">
          {PERSONAS.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="login__card sancta-focusable"
                data-testid={`persona-${p.id}`}
                style={{ '--persona-accent': p.accent } as CSSProperties}
                onClick={() => onSignIn(p)}
              >
                <span className="login__avatar" aria-hidden="true">{p.label.slice(0, 1)}</span>
                <span className="login__card-body">
                  <span className="login__card-title">{p.label}</span>
                  <span className="login__card-blurb">{p.blurb}</span>
                </span>
                <span className="login__card-go" aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>

        <footer className="login__foot">
          Synthetic demo data only — no real patient information. Your role sets what you can see and do.
        </footer>
      </div>
    </div>
  );
}
