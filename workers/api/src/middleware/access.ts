import type { MiddlewareHandler } from 'hono';
import { verifyAccessJwt, type AccessIdentity } from '@design-manager/shared';
import type { AppBindings } from '../env';

const INTERNAL_TOKEN_HEADER = 'X-Internal-Service-Token';
const INTERNAL_SOURCE_HEADER = 'X-Internal-Source-Product';

/**
 * Authenticates every request. Two accepted channels:
 *   1. `Cf-Access-Jwt-Assertion` — humans (SSO) or Access Service Tokens that
 *      traversed the zone. Validated against the team JWKS.
 *   2. `X-Internal-Service-Token` — SaaS Workers calling over a Service Binding,
 *      which bypasses the zone (and therefore Access). Compared in constant time
 *      against the INTERNAL_SERVICE_TOKEN Workers Secret. The caller's
 *      `X-Internal-Source-Product` is used only for audit tagging.
 *
 * Defense-in-depth: a missing/invalid credential on either channel returns 401
 * even if Access is meant to gate the zone.
 */
export function accessMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const internalToken = c.req.header(INTERNAL_TOKEN_HEADER);
    if (internalToken) {
      if (!timingSafeEqual(internalToken, c.env.INTERNAL_SERVICE_TOKEN)) {
        return c.json({ error: 'invalid internal service token' }, 401);
      }
      const productId = c.req.header(INTERNAL_SOURCE_HEADER) ?? 'unknown';
      const identity: AccessIdentity = {
        email: undefined,
        clientId: `saas:${productId}`,
        isServiceToken: true,
        raw: { sub: `saas:${productId}`, aud: 'internal-binding' },
      };
      c.set('identity', identity);
      return next();
    }

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
