/**
 * Session (device-local). The chosen persona is held in localStorage so a reload keeps
 * the operator signed in on this device. api.ts reads the roles/user from here so every
 * request carries the persona's RBAC context; the shell reads the persona to scope its
 * navigation. No credentials are stored — a real deployment binds this to an
 * authenticated, device-bound session.
 */
import { personaById, type Persona } from './personas.ts';

const KEY = 'sancta.persona';

function safeGet(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function currentPersonaId(): string | null {
  return safeGet();
}

export function currentPersona(): Persona | null {
  return personaById(safeGet());
}

export function signIn(personaId: string): void {
  try {
    localStorage.setItem(KEY, personaId);
  } catch {
    /* private-mode / storage disabled: session stays in memory for this tab only */
  }
}

export function signOut(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* no-op */
  }
}

const DEFAULT_ROLES = 'reception,clinical,cashier,stock';

/** RBAC roles for the current persona, comma-joined for the `x-roles` header. */
export function sessionRoles(): string {
  const p = currentPersona();
  return p ? p.roles.join(',') : DEFAULT_ROLES;
}

/** Non-PHI actor id for the `x-user` header and audit trail. */
export function sessionUser(): string {
  return currentPersona()?.id ?? 'demo-operator';
}
