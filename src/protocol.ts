/**
 * Session protocol (v3) — browser-side mirror of
 * SteemAuthenticator/src/lib/protocol.ts. Keep the two in lockstep;
 * scripts/verify-protocol.ts cross-checks them automatically.
 *
 * v3 (relay plane): the QR carries `rt` (the relay URL — the only endpoint
 * anyone ever needs), `rm` (an unguessable room) and `tk` (the PHONE token —
 * the app keeps its own token out of the QR). The relay stores per-room
 * sequenced logs with replay, so durability survives refreshes and
 * backgrounded phones WITHOUT shipping any database credential to a client.
 * Every envelope is encrypt-then-MAC'd with keys derived from `k`, so the
 * relay can neither read messages nor inject one that verifies.
 * v1/v2 payloads are refused by the version check on both sides.
 */
import { AES, HmacSHA256, SHA256, Utf8 } from 'crypto-es';
import type {
  CreateSessionOptions,
  SessionMessage,
  SessionQrPayload,
} from './types';

export const PROTOCOL_VERSION = 3;
export const PAYLOAD_TYPE = 'steem.session';
/** Default lifetime of a QR code before the mobile app refuses it. */
export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
/**
 * The relay plane — the single, public endpoint every session rides. This is
 * a NON-credential constant (a wss:// URL, already public in every QR):
 * self-hosters pass `relayUrl` to use their own relay instead.
 */
export const DEFAULT_RELAY_URL = 'wss://relay.steempro.com';

/** Format gates — byte-identical with the relay's rules. */
export const ROOM_RE = /^rm_[A-Za-z0-9_-]{16,64}$/;
export const TOKEN_RE = /^tok_[A-Za-z0-9_-]{32,128}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Secure random source — throws a clear error instead of failing later when
 * the environment has no WebCrypto (e.g. Node.js < 20 without a flag).
 */
function secureRandom(): Crypto {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new ProtocolError(
      'No secure random source (WebCrypto) available — use a browser or Node.js 22+',
    );
  }
  return c;
}

/** Generate a random session key (base64, 32 bytes). */
export function generateSessionKey(): string {
  const bytes = new Uint8Array(32);
  secureRandom().getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Generate a session id (uuid v4 when available). */
export function generateSessionId(): string {
  const crypto = secureRandom();
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 32 hex chars (16 bytes) from WebCrypto — the auth challenge nonce. */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  secureRandom().getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** base64url without padding (relay-compatible token/room alphabet). */
function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  secureRandom().getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unguessable room name (~176 bits) — the relay refuses anything else. */
export function generateRoom(): string {
  return `rm_${randomBase64Url(22)}`;
}

/**
 * A room token (~256 bits). The QR carries the PHONE token; the app keeps
 * its own token out of the QR entirely (only its sha256 hash is sent to the
 * relay at room creation, so the relay stores nothing but hashes).
 */
export function generateToken(): string {
  return `tok_${randomBase64Url(32)}`;
}

/** sha256 hex — token hashing for room registration. */
export function sha256Hex(input: string): string {
  return SHA256(input).toString();
}

/**
 * MAC key derived from the session key — domain-separated from the cipher's
 * own KDF so the two never share material. Both sides derive it identically.
 */
function macKeyFor(sessionKey: string): string {
  return SHA256(`steemauth-v3-mac:${sessionKey}`).toString();
}

/** HMAC-SHA256 hex over `data` with the session's MAC key. */
export function hmacHex(data: string, sessionKey: string): string {
  return HmacSHA256(data, macKeyFor(sessionKey)).toString();
}

/**
 * The page origin this code is running on — captured automatically so the
 * QR carries the REAL requesting origin (`src`) without any option to
 * override it. `window.location` is [Unforgeable] in browsers: page script
 * cannot replace `origin` with a lie, which is exactly why the phone is
 * willing to display it as the app's URL.
 *
 * Returns undefined outside browsers (SSR / Node) — the field is then
 * simply absent, and the phone falls back to the declared `url`.
 */
function currentPageOrigin(): string | undefined {
  try {
    const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    // Strict origin shape: scheme + host (+ port), no path, no trailing slash.
    if (typeof origin === 'string' && /^https?:\/\/[^\s/]+$/.test(origin)) {
      return origin;
    }
  } catch {
    /* exotic location implementations — fall through */
  }
  return undefined;
}

/**
 * Build the QR payload for a session (protocol v3). The result is
 * JSON.stringify-ed into the QR; the mobile app validates every field.
 * The payload carries the relay URL (`rt`), the room (`rm`) and the PHONE
 * token (`tk`) — the app's own token never appears here.
 */
/** Steem account names: 3-16 chars, lowercase, a-z / 0-9 / . / - */
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

export function createQrPayload(options: CreateSessionOptions): SessionQrPayload {
  if (!options.appName || !options.appName.trim()) {
    throw new ProtocolError('appName is required (it is shown on the phone)');
  }
  const now = Date.now();
  const ttl = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (ttl < 30_000) {
    throw new ProtocolError('ttlMs must be at least 30 seconds');
  }
  const rt = (options.relayUrl ?? DEFAULT_RELAY_URL).trim();
  if (!/^wss?:\/\//.test(rt)) {
    throw new ProtocolError('relayUrl must be a ws:// or wss:// URL');
  }
  const account = options.account?.trim().toLowerCase();
  if (account !== undefined && !ACCOUNT_RE.test(account)) {
    throw new ProtocolError(`Invalid target account: ${options.account}`);
  }
  return {
    v: PROTOCOL_VERSION,
    t: PAYLOAD_TYPE,
    sid: generateSessionId(),
    app: options.appName.slice(0, 80),
    url: (options.origin ?? '').slice(0, 200),
    // Verified origin — always from the environment, never from options
    // (see currentPageOrigin): there is deliberately no way to override it.
    src: currentPageOrigin(),
    chain: 'steem',
    rt,
    rm: generateRoom(),
    tk: generateToken(),
    k: generateSessionKey(),
    ts: now,
    exp: now + ttl,
    account,
  };
}

/** Serialize a payload into the QR string. */
export function serializeQrPayload(payload: SessionQrPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse + validate a QR payload with the exact rules the mobile app enforces
 * (mirrors `parseSessionQr` in SteemAuthenticator/src/lib/protocol.ts), and
 * normalize the result the same way. Useful for tests / self-checks — the
 * same validation runs on the mobile side before connecting.
 */
export function parseQrPayload(raw: string, now = Date.now()): SessionQrPayload {
  let data: any;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new ProtocolError('Not a SteemAuthenticator QR code (invalid JSON)');
  }
  if (!data || typeof data !== 'object') {
    throw new ProtocolError('Not a SteemAuthenticator QR code');
  }
  if (data.t !== PAYLOAD_TYPE) {
    throw new ProtocolError('Unsupported QR code type');
  }
  if (data.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${data.v}`);
  }
  if (typeof data.sid !== 'string' || data.sid.length < 8) {
    throw new ProtocolError('QR code is missing a session id');
  }
  if (typeof data.k !== 'string' || data.k.length < 16) {
    throw new ProtocolError('QR code is missing its encryption key');
  }
  if (typeof data.exp !== 'number' || data.exp < now) {
    throw new ProtocolError('This QR code has expired — refresh it on the app');
  }
  if (typeof data.ts === 'number' && data.ts > now + 60_000) {
    throw new ProtocolError('QR code clock is in the future — check device time');
  }
  if (data.chain && data.chain !== 'steem') {
    throw new ProtocolError(`Unsupported chain: ${data.chain}`);
  }
  if (data.src !== undefined) {
    // Strict ORIGIN shape — kept byte-identical with the phone's
    // parseSessionQr rule so the cross-repo parity suite holds: host[:port]
    // only, no path/query/fragment/userinfo/whitespace (display-spoofing
    // material for the blocklist and approval UI otherwise).
    if (typeof data.src !== 'string' || !/^https?:\/\/(?:\[[^\]]+\]|[^/?#\s@]+)(?::\d+)?$/.test(data.src)) {
      throw new ProtocolError('QR code has an invalid app URL');
    }
  }
  // v3: the relay rendezvous fields are MANDATORY — without them there is
  // no room to join. `sup` (v2) is deliberately absent: version check runs
  // first, so a v2 QR dies here with `Unsupported protocol version: 2`.
  if (typeof data.rt !== 'string' || !/^wss?:\/\//.test(data.rt)) {
    throw new ProtocolError('QR code is missing its relay URL (rt)');
  }
  if (typeof data.rm !== 'string' || !ROOM_RE.test(data.rm)) {
    throw new ProtocolError('QR code has an invalid room name (rm)');
  }
  if (typeof data.tk !== 'string' || !TOKEN_RE.test(data.tk)) {
    throw new ProtocolError('QR code has an invalid room token (tk)');
  }
  let account: string | undefined;
  if (data.account !== undefined) {
    const acc = typeof data.account === 'string' ? data.account.trim().toLowerCase() : '';
    if (!ACCOUNT_RE.test(acc)) {
      throw new ProtocolError('QR code has an invalid target account');
    }
    account = acc;
  }
  return {
    v: PROTOCOL_VERSION,
    t: PAYLOAD_TYPE,
    sid: data.sid,
    app: typeof data.app === 'string' ? data.app.slice(0, 80) : 'Unknown app',
    url: typeof data.url === 'string' ? data.url.slice(0, 200) : '',
    chain: 'steem',
    src: typeof data.src === 'string' ? data.src.slice(0, 200) : undefined,
    rt: data.rt.slice(0, 200),
    rm: data.rm,
    tk: data.tk,
    k: data.k,
    ts: typeof data.ts === 'number' ? data.ts : now,
    exp: data.exp,
    account,
  };
}

/**
 * Encrypt a protocol message for transport.
 *
 * Wire format (unchanged, identical to the mobile app's crypto-js output):
 * passphrase-based AES-256-CBC with a random salt, rendered in the OpenSSL
 * "Salted__" base64 envelope. crypto-es is the maintained ES-module
 * implementation of the same algorithm — ciphertexts are interchangeable
 * with the app's (proven both directions by scripts/verify-protocol.ts).
 */
export function encryptMessage(message: SessionMessage, key: string): string {
  return AES.encrypt(JSON.stringify(message), key).toString();
}

/** Decrypt a transport blob back into a protocol message. */
export function decryptMessage(cipher: string, key: string): SessionMessage {
  const bytes = AES.decrypt(cipher, key);
  const text = bytes.toString(Utf8);
  if (!text) throw new ProtocolError('Failed to decrypt message (bad session key)');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.type !== 'string') {
    throw new ProtocolError('Malformed session message');
  }
  return parsed as SessionMessage;
}

/**
 * The v3 wire envelope: encrypt-then-MAC. `c` is the AES blob above; `m` is
 * HMAC-SHA256 over `c` with a key derived from the session key. The relay
 * stores/forwards `{ c, m }` blindly — it cannot read `c`, and any tampering
 * (bit-flips, swaps, injected rows) fails MAC verification and is dropped.
 */
export interface SealedEnvelope {
  c: string;
  m: string;
}

/** Seal a message into a relay-safe envelope. */
export function sealMessage(message: SessionMessage, key: string): SealedEnvelope {
  const c = encryptMessage(message, key);
  return { c, m: hmacHex(c, key) };
}

/**
 * Verify + open an envelope. Returns null for anything that fails MAC
 * verification or decryption — callers MUST treat null as "drop silently"
 * (a malicious or buggy relay has nothing it can inject that survives).
 */
export function openMessage(envelope: unknown, key: string): SessionMessage | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const { c, m } = envelope as { c?: unknown; m?: unknown };
  if (typeof c !== 'string' || typeof m !== 'string' || !MAC_RE.test(m)) return null;
  // Constant-time-ish tag compare (hex of equal length, via the derived key
  // computation — timing of the hash itself is not secret-dependent here).
  const expected = hmacHex(c, key);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ m.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return decryptMessage(c, key);
  } catch {
    return null;
  }
}
