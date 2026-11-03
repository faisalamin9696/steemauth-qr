/**
 * `watchRevocation()` — registry-backed revocation watch over the relay.
 *
 * The relay (optionally) holds a Supabase-backed session registry: when the
 * user revokes this app from the authenticator's Sessions tab, the phone
 * writes `revoked_at` and the relay pushes `{ t:"revoked", sid, reason }`
 * to every connection watching that sid. This helper is that connection.
 *
 * Why a standalone watch (separate from `SteemAuthSession`):
 *
 *   - the LOGIN sid is the key the registry rows are stored under, and the
 *     session's own sid changes on `refresh()` — so the durable watch belongs
 *     to the account, not to a session instance;
 *   - it outlives the relay room (rooms idle out and are swept) and needs no
 *     room membership at all;
 *   - it outlives transient network drops: unexpected closes reconnect with
 *     capped backoff and re-watch, and the relay re-checks the registry on
 *     every `watch`, so a revoke that happened while we were offline still
 *     fires as soon as we are back.
 *
 * Security / failure posture — the missing control plane never breaks the
 * app: a relay without a registry configured refuses the frame and this
 * helper closes silently (fail-open); there is no credential anywhere on
 * the client (Supabase lives only inside the relay); `onRevoked` fires at
 * most once.
 *
 * ```ts
 * const watch = watchRevocation({
 *   sid: account.sid,          // the sid the account LOGGED IN with
 *   onRevoked: (reason) => signOut(reason),
 * });
 * // later: watch.close();
 * ```
 */
import { SteemAuthError } from './errors';
import { DEFAULT_RELAY_URL } from './protocol';

/**
 * Session-id shape (UUID v4 — what `generateSessionId()` produces). Mirrors
 * the relay's own gate: refusing bad input client-side keeps it from ever
 * reaching a wire frame.
 */
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Backoff schedule for unexpected drops: 1 s, 2 s, 4 s … capped at 30 s. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RevocationWatchOptions {
  /** The session id to watch — the LOGIN sid (registry rows are keyed by it). */
  sid: string;
  /** Relay base URL — defaults to `DEFAULT_RELAY_URL`. */
  relayUrl?: string;
  /** Fires once when the relay reports this sid revoked. */
  onRevoked(reason: string): void;
}

export interface RevocationWatch {
  /** Stop watching — closes the connection, no reconnects after this. Idempotent. */
  close(): void;
  /** Resolves when the watch is finished: revoked, refused, or closed. */
  readonly closed: Promise<void>;
}

interface RelayFrame {
  t?: string;
  sid?: unknown;
  reason?: unknown;
  code?: unknown;
}

export function watchRevocation(options: RevocationWatchOptions): RevocationWatch {
  const { sid, onRevoked } = options;
  if (!SID_RE.test(sid)) {
    throw new SteemAuthError('invalid-request', `Not watching — sid is not a valid session id: ${sid}`);
  }
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;

  const Ws = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof Ws !== 'function') {
    throw new SteemAuthError('plane-failed', 'No global WebSocket — use a browser or Node 22+');
  }
  /** Narrowed copy — the typeof check above ran at construction time. */
  const Socket: typeof WebSocket = Ws;

  let ws: WebSocket | null = null;
  let stopped = false; // close() was called — stop for good
  let attempts = 0; // reconnect backoff exponent, reset on a successful watch
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fired = false; // onRevoked fires at most once
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  /** Terminal stop: no more frames, no more reconnects, `closed` resolves. */
  function finish(): void {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        sock.close();
      } catch {
        /* already gone */
      }
    }
    resolveClosed();
  }

  function connect(): void {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new Socket(relayUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      if (stopped) return;
      sock.send(JSON.stringify({ t: 'watch', sid }));
    };

    sock.onmessage = (ev) => {
      if (stopped) return;
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(ev.data)) as RelayFrame;
      } catch {
        return;
      }
      if (frame.t === 'watched') {
        attempts = 0; // registered — future drops restart the backoff
        return;
      }
      if (frame.t === 'revoked') {
        if (!fired) {
          fired = true;
          try {
            onRevoked(
              typeof frame.reason === 'string' && frame.reason
                ? frame.reason
                : 'Access was revoked in the authenticator.',
            );
          } finally {
            finish();
          }
        }
        return;
      }
      if (frame.t === 'err') {
        // Refused (relay without a registry / older relay / bad frame):
        // terminal and SILENT — the in-room path still works, and a missing
        // control plane must never surface as an error to the user.
        finish();
      }
    };

    sock.onclose = () => {
      if (stopped) return;
      ws = null;
      scheduleReconnect();
    };
    sock.onerror = () => {
      /* onclose follows and drives the recovery path */
    };
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempts, 10));
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  connect();

  return {
    close(): void {
      if (stopped) return;
      finish();
    },
    closed,
  };
}
