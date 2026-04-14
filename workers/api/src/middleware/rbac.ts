import type { MiddlewareHandler } from 'hono';
import type { AclRow } from '@design-manager/shared';
import type { AppBindings } from '../env';

export type Role = AclRow['role'];

const roleRank: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function requireRole(min: Role): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const identity = c.get('identity');

    // Service tokens are trusted callers (SaaS Workers); treat as operator by default.
    // Tighten per-route if a higher bar is needed.
    if (identity.isServiceToken) return next();

    if (!identity.email) return c.json({ error: 'no email in access jwt' }, 403);

    const row = await c.env.DB
      .prepare('SELECT role FROM acl WHERE email = ?1')
      .bind(identity.email)
      .first<{ role: Role }>();

    if (!row) return c.json({ error: 'not in acl' }, 403);
    if (roleRank[row.role] < roleRank[min]) {
      return c.json({ error: `role ${row.role} insufficient (need ${min})` }, 403);
    }
    return next();
  };
}
