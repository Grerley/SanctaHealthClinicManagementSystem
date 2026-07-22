/**
 * Request → authenticated context. In PRODUCTION this is fronted by Cloudflare
 * Access: Access authenticates the user and passes a verified identity header,
 * which we map to roles. For local dev / the skeleton, we accept the same
 * `x-roles`/`x-user` headers the edge used. Replacing the header path with a real
 * Access identity → role lookup is Phase D6.
 */
import type { Role } from '@sancta/domain';

export type AuthContext = { user: string | null; roles: Role[] };

const KNOWN_ROLES = new Set<Role>(['reception', 'clinical', 'cashier', 'stock', 'finance', 'manager', 'administrator', 'auditor']);

export function authFromRequest(request: Request): AuthContext {
  // D6: prefer the Cloudflare Access verified identity when present.
  const accessEmail = request.headers.get('cf-access-authenticated-user-email');
  const rolesHeader = request.headers.get('x-roles') ?? '';
  const roles = rolesHeader
    .split(',')
    .map((s) => s.trim())
    .filter((r): r is Role => KNOWN_ROLES.has(r as Role));
  const user = accessEmail ?? request.headers.get('x-user');
  return { user, roles };
}
