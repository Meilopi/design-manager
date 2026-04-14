import { b64urlDecode, b64urlEncode } from '@design-manager/shared';

const enc = new TextEncoder();

/**
 * HS256 JWT signer using Web Crypto — no dependency on `jose`.
 * `rawKeyB64url` must decode to at least 32 bytes (recommended for HS256).
 */
export async function signHs256Jwt(
  rawKeyB64url: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = b64urlEncode(enc.encode(JSON.stringify(header)));
  const encodedPayload = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    b64urlDecode(rawKeyB64url),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}
