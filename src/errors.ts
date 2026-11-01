/**
 * Typed errors — one class, a closed set of machine-readable codes.
 *
 * Every failure the package raises is a `SteemAuthError`, so callers can
 * branch on `err.code` instead of matching message strings, while the human
 * message stays stable (UIs may display it, tests assert it).
 */

export type SteemAuthErrorCode =
  /** Session/controller was disposed — no further use possible. */
  | 'disposed'
  /** The user revoked this app in the authenticator — session is over. */
  | 'revoked'
  /** connect()/start() has not completed (or failed) yet. */
  | 'not-connected'
  /** No authenticator account yet — the phone has not scanned. */
  | 'no-account'
  /** The QR (and therefore the session) has expired. */
  | 'session-expired'
  /** A request failed validation before it was sent. */
  | 'invalid-request'
  /** No answer from the phone within the request timeout. */
  | 'timeout'
  /** The relay-room join took too long. */
  | 'plane-timeout'
  /** The relay connection failed (join error, send failure). */
  | 'plane-failed';

export class SteemAuthError extends Error {
  readonly code: SteemAuthErrorCode;

  constructor(code: SteemAuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SteemAuthError';
    this.code = code;
  }
}

/** Normalize anything thrown into its message string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Type guard for SteemAuthError (works across bundles/copies). */
export function isSteemAuthError(e: unknown): e is SteemAuthError {
  return e instanceof Error && e.name === 'SteemAuthError' && 'code' in e;
}
