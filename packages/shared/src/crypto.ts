/**
 * AES-GCM envelope encryption for ephemeral auth payloads carried through the
 * queue message / Workflow params. Key material: a 32-byte raw key held in
 * the `AUTH_ENC_KEY` Workers Secret, base64url-encoded.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(rawKeyB64url: string): Promise<CryptoKey> {
  const raw = b64urlDecode(rawKeyB64url);
  if (raw.byteLength !== 32) {
    throw new Error(`AUTH_ENC_KEY must decode to 32 bytes (got ${raw.byteLength})`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedEnvelope {
  ciphertext: string; // base64url
  iv: string;         // base64url
}

export async function encryptJson(rawKeyB64url: string, plaintext: unknown): Promise<EncryptedEnvelope> {
  const key = await importKey(rawKeyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(plaintext)),
  );
  return { ciphertext: b64urlEncode(ct), iv: b64urlEncode(iv) };
}

export async function decryptJson<T = unknown>(
  rawKeyB64url: string,
  envelope: EncryptedEnvelope,
): Promise<T> {
  const key = await importKey(rawKeyB64url);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(envelope.iv) },
    key,
    b64urlDecode(envelope.ciphertext),
  );
  return JSON.parse(dec.decode(pt)) as T;
}
