import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { HttpError } from './http.ts';

// Google sign-in. The app asks Google for an ID token (a signed note that says which Google account this is) and sends
// it here. The server checks Google's signature, that the note was made for this app and has not run out, and then keeps
// only the account's number ("sub"). Nothing else Google says about the person, the email address included, is kept.

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Clocks drift: a token is still taken this long after the time it says it ends. */
const SKEW_MS = 60_000;

/**
 * The OAuth client ids (Google Cloud → APIs & Services → Credentials) whose tokens are accepted, comma separated in
 * GOOGLE_CLIENT_ID. The first is the "Web application" client the app names when it asks Google for a token. With none,
 * Google sign-in is off and the app shows no Google button.
 */
export const googleClientIds = () =>
  (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);

type Jwk = { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown };
type KeySet = { at: number; maxAgeMs: number; byKid: Map<string, KeyObject> };

let cache: KeySet | null = null;
let testKeys: Jwk[] | null = null;

/** For the checks only: tokens are checked against these keys instead of Google's. null goes back to Google's. */
export function useGoogleTestKeys(keys: Jwk[] | null) {
  testKeys = keys;
  cache = null;
}

const failed = () => new HttpError(401, 'google_failed', 'Google sign-in did not work. Please try again.');
const unreachable = () => new HttpError(503, 'google_unreachable', 'Google could not be reached. Please try again in a minute.');

async function loadKeys(): Promise<KeySet> {
  let list: Jwk[];
  let maxAgeMs = 60 * 60_000;
  if (testKeys) list = testKeys;
  else {
    let res: Response;
    try {
      res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw unreachable();
    }
    if (!res.ok) throw unreachable();
    const body = (await res.json().catch(() => ({}))) as { keys?: unknown };
    list = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
    // Google says how long its keys may be kept; never more than a day here.
    const age = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
    if (age) maxAgeMs = Math.min(Number(age[1]) * 1000, 24 * 60 * 60_000);
  }
  const byKid = new Map<string, KeyObject>();
  for (const k of list) {
    if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    try {
      byKid.set(k.kid, createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }));
    } catch {
      // A key that cannot be read is left out; a token signed with it is refused.
    }
  }
  return { at: Date.now(), maxAgeMs, byKid };
}

async function keyFor(kid: string): Promise<KeyObject | undefined> {
  const stale = !cache || Date.now() - cache.at > cache.maxAgeMs;
  // A key never seen may be a new one Google has started to sign with: look again, at most once a minute.
  const unknown = !!cache && !cache.byKid.has(kid) && Date.now() - cache.at > 60_000;
  if (stale || unknown) cache = await loadKeys();
  return cache!.byKid.get(kid);
}

const part = (s: string): any => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

/** Checks a Google ID token and returns whose it is. Anything wrong with the token is one plain 401. */
export async function verifyGoogleToken(token: string, audiences: string[]): Promise<{ sub: string; name: string | null }> {
  if (token.length > 8192) throw failed();
  const parts = token.split('.');
  if (parts.length !== 3) throw failed();
  const [h, p, s] = parts;
  const header = part(h);
  const claims = part(p);
  if (!header || !claims || typeof claims !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string') throw failed();
  const key = await keyFor(header.kid);
  if (!key) throw failed();
  let signed = false;
  try {
    signed = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) throw failed();
  const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(claims.iss) || !aud.some((a) => typeof a === 'string' && audiences.includes(a))) throw failed();
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + SKEW_MS < Date.now()) throw failed();
  if (typeof claims.sub !== 'string' || !/^[0-9A-Za-z_-]{1,255}$/.test(claims.sub)) throw failed();
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);
  return { sub: claims.sub, name: pick(claims.name) ?? pick(claims.given_name) };
}
