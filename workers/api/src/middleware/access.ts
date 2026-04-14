import type { MiddlewareHandler } from 'hono';
import { verifyAccessJwt } from '@design-manager/shared';
import type { AppBindings } from '../env';

/**
 * Defense-in-depth even though the Access application gates the hostname:
 * every request must carry a valid Cf-Access-Jwt-Assertion (human or Service Token).
 */
export function accessMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) return c.json({ error: 'missing Cf-Access-Jwt-Assertion' }, 401);

    try {
      const identity = await verifyAccessJwt(token, {
        teamDomain: c.env.ACCESS_TEAM_DOMAIN,
        audience: c.env.ACCESS_AUD,
        jwksCache: c.env.JWKS_CACHE,
      });
      c.set('identity', identity);
    } catch (err) {
      return c.json({ error: `access jwt invalid: ${(err as Error).message}` }, 401);
    }
    return next();
  };
}
