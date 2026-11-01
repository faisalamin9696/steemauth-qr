/**
 * Relay plane (protocol v3) — the ONLY session transport.
 *
 * A thin, typed client for the durable relay wire (see steemauth-relay
 * server.js): `create` (app side, registers the room with TOKEN HASHES) →
 * `join` → `pull` (replay from the cursor) → `msg`/`ack` (live traffic).
 *
 * Security properties this client upholds:
 *   - it only ever sends well-formed `{ c, m }` envelopes (encrypt-then-MAC;
 *     see `sealMessage`/`openMessage` in protocol.ts) — the relay stores and
 *     forwards blobs it cannot read;
 *   - tokens ride the TLS-protected socket only; the app's own token never
 *     touches the QR;
 *   - a dropped socket is healed by rejoin + replay from `cursor`, so
 *     refreshes, backgrounding and network handoffs lose nothing;
 *   - every failure is typed (`plane-timeout` / `plane-failed` /
 *     `invalid-request`) — never a silent dead session.
 *
 * Requires a global `WebSocket` (all browsers; Node 22+ / tests inject their
 * own factory through the `planeFactory` seam).
 */
import { SteemAuthError } from './errors';

export type RelayPlaneStatus = 'connecting' | 'connected' | 'failed';

export interface RelayPlaneOptions {
  /** ws(s):// URL of the relay (QR's `rt`). */
  relayUrl: string;
  /** Room name (QR's `rm`). */
  room: string;
  /** This side's token: the app keeps its token, the phone uses QR's `tk`. */
  token: string;
  /**
   * App side only — register the room BEFORE joining: sha256 hashes of both
   * tokens plus the room lifetime. The relay acks idempotently, so resume
   * re-registration is safe.
   */
  create?: { appHash: string; phoneHash: string; ttlMs: number };
  /** Handshake budget (create + join + first pull). */
  handshakeTimeoutMs?: number;
  /** Raw envelope delivered by the peer — verify with `openMessage`. */
  onMessage(payload: unknown): void;
  onStatus?(status: RelayPlaneStatus): void;
}

export interface MessagePlane {
  /** Append one sealed envelope to the room's log. Throws typed errors. */
  send(payload: unknown): Promise<void>;
  /** Stop listening (the log lives on until the relay sweeps the room). */
  close(): void;
  /** Highest `seq` delivered/acknowledged so far (replay cursor). */
  readonly cursor: number;
}

/** How a session builds its transport — injectable seam for offline tests. */
export type MessagePlaneFactory = (options: RelayPlaneOptions) => MessagePlane;

/** Parity with the relay's stored-envelope budget. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

interface SendWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ENVELOPE_RE = /^[0-9a-f]{64}$/;

/** Shape-check an envelope exactly like the relay does (defense in depth). */
function isEnvelope(payload: unknown): payload is { c: string; m: string } {
  if (!payload || typeof payload !== 'object') return false;
  const keys = Object.keys(payload);
  const { c, m } = payload as { c?: unknown; m?: unknown };
  return (
    keys.length > 0 &&
    keys.every((k) => k === 'c' || k === 'm') &&
    typeof c === 'string' &&
    typeof m === 'string' &&
    ENVELOPE_RE.test(m)
  );
}

function errFor(code: string, phase: 'handshake' | 'send'): SteemAuthError {
  if (phase === 'handshake') {
    switch (code) {
      case 'bad_token':
        return new SteemAuthError('plane-failed', 'Relay rejected the room token');
      case 'room_expired':
        return new SteemAuthError('plane-timeout', 'Relay room expired — generate a fresh QR code');
      case 'rate_limited':
        return new SteemAuthError('plane-failed', 'Relay rate-limited the session setup — retry shortly');
      default:
        return new SteemAuthError('plane-failed', `Relay refused the session (${code})`);
    }
  }
  switch (code) {
    case 'room_log_full':
      return new SteemAuthError('plane-failed', 'Relay room log is full — session unusable');
    case 'rate_limited':
      return new SteemAuthError('plane-failed', 'Relay rate-limited a message — retry shortly');
    case 'room_expired':
      return new SteemAuthError('plane-failed', 'Relay room expired under us — refresh the QR');
    default:
      return new SteemAuthError('plane-failed', `Relay refused a message (${code})`);
  }
}

export function createRelayPlane(options: RelayPlaneOptions): MessagePlane {
  const { relayUrl, room, token, create, onMessage, onStatus } = options;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;

  let ws: WebSocket | null = null;
  let cursor = 0;
  let closed = false;
  let connected = false;
  let attempts = 0;
  let handshakeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** FIFO of in-flight sends — the relay acks in order, one connection. */
  const outbox: SendWaiter[] = [];

  const status = (s: RelayPlaneStatus) => onStatus?.(s);

  const failHandshake = (e: Error) => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    const w = handshakeWaiter;
    handshakeWaiter = null;
    w?.reject(e);
  };

  const resolveSend = () => {
    const w = outbox.shift();
    if (!w) return;
    clearTimeout(w.timer);
    w.resolve();
  };
  const rejectSend = (e: Error) => {
    const w = outbox.shift();
    if (!w) return;
    clearTimeout(w.timer);
    w.reject(e);
  };

  function deliver(rows: Array<[number, unknown]>) {
    for (const [seq, payload] of rows) {
      if (!Number.isInteger(seq) || seq <= cursor) continue; // replay ∩ live dedup
      cursor = seq;
      try {
        onMessage(payload);
      } catch {
        // a throwing receiver must not stall the stream
      }
    }
  }

  function attach(handshake: { resolve: () => void; reject: (e: Error) => void }) {
    const Ws = (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
    if (typeof Ws !== 'function') {
      throw new SteemAuthError('plane-failed', 'No global WebSocket — use a browser or Node 22+');
    }
    const sock = new Ws(relayUrl);
    ws = sock;
    status('connecting');
    // Explicit handshake phases: create → join → rows. (The relay acks each
    // step in order; pulling before the join would get `not_member`.)
    let phase: 'create' | 'join' | 'rows' = create ? 'create' : 'join';

    handshakeTimer = setTimeout(() => {
      failHandshake(new SteemAuthError('plane-timeout', 'Timed out joining the relay room — check the relayUrl and network'));
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }, handshakeTimeoutMs);

    sock.onopen = () => {
      if (closed) return;
      if (create) {
        sock.send(JSON.stringify({ t: 'create', room, toks: [create.appHash, create.phoneHash], ttlMs: create.ttlMs }));
      } else {
        sock.send(JSON.stringify({ t: 'join', room, tok: token }));
      }
    };

    sock.onmessage = (ev) => {
      if (closed) return;
      let frame: {
        t?: string;
        code?: string;
        cursor?: number;
        rows?: Array<[number, unknown]>;
        seq?: number;
        payload?: unknown;
      };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (frame.t) {
        case 'ok': {
          if (typeof frame.cursor === 'number') cursor = Math.max(cursor, frame.cursor);
          if (!handshakeWaiter) break;
          if (phase === 'create') {
            phase = 'join';
            sock.send(JSON.stringify({ t: 'join', room, tok: token }));
          } else if (phase === 'join') {
            phase = 'rows';
            sock.send(JSON.stringify({ t: 'pull', cursor }));
          }
          break;
        }
        case 'rows': {
          deliver(frame.rows ?? []);
          if (handshakeWaiter) {
            const w = handshakeWaiter;
            handshakeWaiter = null;
            if (handshakeTimer) clearTimeout(handshakeTimer);
            handshakeTimer = null;
            connected = true;
            attempts = 0;
            status('connected');
            w.resolve();
          }
          break;
        }
        case 'msg': {
          if (typeof frame.seq === 'number') deliver([[frame.seq, frame.payload]]);
          break;
        }
        case 'ack': {
          if (typeof frame.seq === 'number') cursor = Math.max(cursor, frame.seq);
          resolveSend();
          break;
        }
        case 'err': {
          if (handshakeWaiter) {
            failHandshake(errFor(frame.code ?? 'bad_shape', 'handshake'));
          } else {
            rejectSend(errFor(frame.code ?? 'bad_shape', 'send'));
          }
          break;
        }
        default:
          break;
      }
    };

    const onDown = () => {
      if (closed) return;
      connected = false;
      ws = null;
      // Any in-flight send died with the socket.
      while (outbox.length) rejectSend(new SteemAuthError('plane-failed', 'Connection to the relay dropped mid-send'));
      if (handshakeWaiter) {
        failHandshake(new SteemAuthError('plane-timeout', 'Relay connection dropped during handshake'));
      }
      if (attempts >= 3) {
        status('failed');
        return;
      }
      const delay = 400 * 2 ** attempts;
      attempts += 1;
      status('connecting');
      reconnectTimer = setTimeout(() => {
        if (closed) return;
        try {
          attach({ resolve: () => {}, reject: () => {} });
        } catch {
          status('failed');
        }
      }, delay);
    };
    sock.onclose = onDown;
    sock.onerror = () => {
      /* onclose follows and drives the recovery path */
    };
  }

  // Kick off the handshake (create → join → pull).
  const ready = new Promise<void>((resolve, reject) => {
    handshakeWaiter = { resolve, reject };
    try {
      attach(handshakeWaiter);
    } catch (e) {
      reject(e);
    }
  });
  // A rejected handshake must never become an unhandled rejection when the
  // caller only listens via status.
  ready.catch(() => {});

  return {
    get cursor() {
      return cursor;
    },
    async send(payload: unknown): Promise<void> {
      if (closed) throw new SteemAuthError('plane-failed', 'Message plane closed');
      if (!isEnvelope(payload)) {
        throw new SteemAuthError('invalid-request', 'Request not sent — malformed envelope');
      }
      if (JSON.stringify(payload).length > MAX_ENVELOPE_BYTES) {
        throw new SteemAuthError('invalid-request', 'Request not sent — message exceeds the 64 KB transport limit');
      }
      await ready; // never send before the first pull completed
      if (!connected || !ws || ws.readyState !== 1) {
        throw new SteemAuthError('plane-failed', 'Message plane not connected');
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = outbox.indexOf(waiter);
          if (i >= 0) outbox.splice(i, 1);
          reject(new SteemAuthError('timeout', 'Relay did not acknowledge a message in time'));
        }, 10_000);
        const waiter: SendWaiter = { resolve, reject, timer };
        outbox.push(waiter);
        try {
          ws!.send(JSON.stringify({ t: 'msg', payload }));
        } catch (e) {
          const i = outbox.indexOf(waiter);
          if (i >= 0) outbox.splice(i, 1);
          clearTimeout(timer);
          reject(new SteemAuthError('plane-failed', e instanceof Error ? e.message : 'send failed'));
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failHandshake(new SteemAuthError('plane-failed', 'Message plane closed'));
      while (outbox.length) rejectSend(new SteemAuthError('plane-failed', 'Message plane closed'));
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
