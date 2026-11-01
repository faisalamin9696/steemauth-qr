/**
 * API types — the shapes integrators construct and receive. Keychain-style
 * request/result shapes mirror what SteemKeychain developers already use
 * (`window.steem_keychain.requestBroadcast` etc.), so existing integrations
 * port with minimal changes.
 */
import type { KeyType, Operation, SignRequest } from './wire';

/**
 * Keychain-compatible request. Either pass one of these straight to
 * `session.request()`, or use the typed helpers (requestBroadcast,
 * requestVote, requestTransfer, …) which build them for you.
 */
export interface KeychainRequest {
  /** optional — generated when omitted */
  id?: string;
  username: string;
  /** Steem operations to broadcast, e.g. [["vote", {...}]] */
  operations: Operation[];
  /**
   * Off-chain signing request. When set, `operations` must be empty: the
   * phone signs `sign.data` and returns the signature without broadcasting
   * anything. See `requestSignBuffer` / `authenticate()`.
   */
  sign?: SignRequest;
  keyType?: KeyType;
  /** request method name, for display ("requestBroadcast", "requestVote"…) */
  method?: string;
  /** app name shown on the phone (defaults to session app) */
  appName?: string;
  /**
   * Human-readable summary sent as `meta.description` (shown on the phone
   * once the app starts rendering request metadata). Defaults to `method`.
   */
  description?: string;
  /**
   * Deep-link / return URL echoed to the mobile app.
   *
   * NOTE: ordinary requests have **no expiry option** — they always ride the
   * QR's own window (`payload.exp`, default 5 min). The only request with a
   * client-settable expiry is `session.authenticate()` (`expiresAt` /
   * `expiresInMs`), whose window is exclusive to the authorization challenge.
   */
  callback?: string;
}

/** Keychain-style result delivered to your callback / promise. */
export interface KeychainResult {
  id: string;
  success: boolean;
  /** method the request was made with */
  method?: string;
  account?: string;
  data?: {
    /** broadcast transaction id (hex, 40 chars) */
    txId?: string;
    /** raw result fields returned by the mobile app */
    [key: string]: unknown;
  };
  error?: string;
  message?: string;
}

/**
 * A signed authentication challenge — the result of `authenticate()`.
 *
 * The `message` is the exact UTF-8 string the phone signed. Send it (plus
 * `signature`, `nonce`, `account`, `expiresAt`) to your backend, verify the
 * signature against the account's posting key, and check `nonce` is fresh
 * and `expiresAt` hasn't passed. That proves control of the key without ever
 * exposing it — a Keychain-style `requestSignBuffer` login.
 */
export interface AuthenticateResult {
  success: boolean;
  /** the account that signed, when the phone connected */
  account?: string;
  /** the challenge that was signed — echo it back to detect replay */
  nonce: string;
  /** ms epoch when the challenge was issued */
  issuedAt: number;
  /** ms epoch after which the signed proof must not be accepted */
  expiresAt: number;
  /** the exact message the phone signed (verify the signature over this) */
  message: string;
  /** compact Steem signature (hex, 65 bytes) over sha256(message) */
  signature?: string;
  error?: string;
}

/**
 * Options for `authenticate()`.
 *
 * Everything is optional — omit them and the package generates a random
 * nonce, a 5-minute expiry and a default statement, so a bare
 * `session.authenticate()` is a complete, replay-safe login challenge.
 */
export interface AuthenticateOptions {
  /** Challenge nonce. Auto-generated (32 hex chars) when omitted. */
  nonce?: string;
  /** ms epoch after which the proof is void. Default: now + 5 minutes. */
  expiresAt?: number;
  /** How long until expiry, in ms. Ignored when `expiresAt` is set. */
  expiresInMs?: number;
  /** Human-readable statement shown on the phone. */
  statement?: string;
  /** Signing key. Posting for login, Active for privileged proofs. */
  keyType?: KeyType;
}

/** Options shared by every session-producing API. */
export interface CreateSessionOptions {
  /** Application name displayed on the phone ("SteemPro"). */
  appName: string;
  /**
   * Target account (optional): the Steem username this session is for. It is
   * embedded in the QR; the phone switches to it automatically on connect so
   * multi-account users never have to pick the right one by hand. Omit for
   * login flows (the scan is what establishes the account).
   */
  account?: string;
  /**
   * Requesting origin, display only (window.location.origin).
   *
   * NOTE: this only fills the informational `url` field. The **verified**
   * origin the phone trusts (`src`) is captured automatically from the page
   * and cannot be set or overridden here.
   */
  origin?: string;
  /**
   * Relay plane to use. Defaults to the shared public relay
   * (DEFAULT_RELAY_URL) — zero configuration required. Self-host
   * `steemauth-relay` and pass its wss:// URL to use your own.
   */
  relayUrl?: string;
  /** QR lifetime in ms (default 5 minutes). */
  ttlMs?: number;
}

/** Connection status surfaced by the session / controller / hook. */
export type ConnectionStatus =
  /** `connect()` in progress — joining the relay room */
  | 'connecting'
  /** room live, waiting for the mobile app to scan */
  | 'waiting'
  /** mobile app scanned and selected an account */
  | 'ready'
  /** relay connection failed (bad URL / network) */
  | 'failed'
  /** the user revoked this app in the authenticator — no reconnecting */
  | 'revoked'
  /** relay closed or `dispose()` was called */
  | 'disconnected';
