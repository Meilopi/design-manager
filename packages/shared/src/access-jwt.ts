import { jwtVerify, createLocalJWKSet, type JSONWebKeySet, type JWTPayload } from 'jose';

const JWKS_CACHE_KEY = 'access:jwks:v1';
const JWKS_TTL_SECONDS = 300;

export interface AccessIdentity {
  email: string | undefined;
  clientId: string | undefined;
  isServiceToken: boolean;
  raw: JWTPayload;
}

export interface VerifyOptions {
  /** e.g. "yourteam.cloudflareaccess.com" */
  teamDomain: string;
  /** AUD tag of the Access application protecting this Worker. */
  audience: string;
  /** KV namespace used to cache the JWKS. Eventual consistency is fine here — JWKS rotates slowly. */
  jwksCache: KVNamespace;
}

async function loadJwks(opts: VerifyOptions): Promise<JSONWebKeySet> {
  const cached = await opts.jwksCache.get(JWKS_CACHE_KEY, 'json');
  if (cached) return cached as JSONWebKeySet;
  const res = await fetch(`https://${opts.teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access jwks fetch failed: ${res.status}`);
  const jwks = (await res.json()) as JSONWebKeySet;
  await opts.jwksCache.put(JWKS_CACHE_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_SECONDS });
  return jwks;
}

/**
 * Verify a `Cf-Access-Jwt-Assertion` header value and return the caller's identity.
 * Accepts both human SSO tokens and Service-Token JWTs; the latter surface with
 * `common_name` instead of `email`.
 */
export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessIdentity> {
  const jwks = await loadJwks(opts);
  const keyset = createLocalJWKSet(jwks);
  const { payload } = await jwtVerify(token, keyset, {
    issuer: `https://${opts.teamDomain}`,
    audience: opts.audience,
  });
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const clientId =
    typeof (payload as Record<string, unknown>).common_name === 'string'
      ? ((payload as Record<string, unknown>).common_name as string)
      : undefined;
  return {
    email,
    clientId,
    isServiceToken: !email && !!clientId,
    raw: payload,
  };
}
