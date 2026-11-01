/**
 * True end-to-end test — offline by design:
 *
 *   SteemAuthSession ──MessagePlane──▶ in-memory relay ◀──MessagePlane── mobile mock
 *   (package under test)              (same contract:      (uses the REAL
 *                                       per-room seq,         mobile app's crypto)
 *                                       replay-on-join,
 *                                       NO sender echo)
 *
 * Injected through the `planeFactory` seam so the full loop — room
 * registration → ready → request → approve/reject/cancel → revoke →
 * resume — runs without a network. The LIVE relay transport is proven by
 * verify-relay-plane.ts against a real relay server; this file proves the
 * session logic on top of it.
 *
 * Run: npx tsx scripts/verify-e2e.ts
 */
import { SteemAuthSession } from '../src/session';
import { createQrSession } from '../src/qr-session';
import { SteemAuthController } from '../src/controller';
import {
  MAX_ENVELOPE_BYTES,
  type MessagePlane,
  type MessagePlaneFactory,
  type RelayPlaneOptions,
} from '../src/relay-plane';
import { requestVote, requestTransfer } from '../src/requests';
import { SteemAuthError, isSteemAuthError } from '../src/errors';
import { openMessage, sealMessage, type SealedEnvelope } from '../src/protocol';
import type { SessionMessage } from '../src/types';
import type { ConnectionStatus } from '../src/types';

import { mobile } from './mobile';

// The REAL mobile app implementation (pure TS — protocol + op validation),
// resolved live from the checkout via scripts/mobile.ts.
const { sealMessage: mobileSeal, openMessage: mobileOpen } = mobile.protocol;
const { validateOperationBatch } = mobile.decoder;

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('      ', JSON.stringify(extra));
  }
}

// ---- In-memory RELAY plane: per-room sequenced log with replay-on-join and
// no sender echo — the exact contract of steemauth-relay v3. ---------------
interface BusRow {
  seq: number;
  payload: unknown;
}
interface RoomMember {
  id: number;
  fn: (row: BusRow) => void;
}
const ROOMS = new Map<
  string,
  { rows: BusRow[]; seq: number; members: Set<RoomMember> }
>();

function roomOf(room: string) {
  let r = ROOMS.get(room);
  if (!r) {
    r = { rows: [], seq: 0, members: new Set() };
    ROOMS.set(room, r);
  }
  return r;
}

let planeCounter = 0;
const memoryRelayFactory: MessagePlaneFactory = (opts: RelayPlaneOptions) => {
  const planeId = ++planeCounter;
  const room = roomOf(opts.room);
  let cursor = 0;
  let closed = false;
  const deliver = (rows: BusRow[]) => {
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      if (row.seq <= cursor) continue; // replay ∩ live overlap — dedup
      cursor = row.seq;
      try {
        (opts.onMessage as (p: unknown, from?: number) => void)(row.payload, (row as { from?: number }).from);
      } catch {
        // a throwing receiver must not stall the stream
      }
    }
  };
  const member: RoomMember = {
    id: planeId,
    fn: (row: BusRow) => {
      if (!closed) deliver([row]);
    },
  };
  room.members.add(member);
  opts.onStatus?.('connecting');
  // Handshake (create/join) resolves, then the backlog pull — same async
  // order as the real relay's `ok` → `rows`.
  setTimeout(() => {
    if (closed) return;
    opts.onStatus?.('connected');
    deliver([...room.rows]);
  }, 0);
  return {
    get cursor() {
      return cursor;
    },
    async send(payload: unknown) {
      if (closed) throw new SteemAuthError('plane-failed', 'relay room closed');
      const json = JSON.stringify(payload);
      if (json.length > MAX_ENVELOPE_BYTES) {
        throw new SteemAuthError(
          'invalid-request',
          'Request not sent — message exceeds the 64 KB transport limit',
        );
      }
      const row: BusRow = { seq: ++room.seq, payload: JSON.parse(json), from: planeId } as BusRow & { from: number };
      room.rows.push(row);
      for (const m of [...room.members]) {
        if (m.id === planeId) continue; // no sender echo — the real relay skips it
        m.fn(row);
      }
    },
    close() {
      closed = true;
      room.members.delete(member);
    },
  };
};

/** A plane that never connects — for timeout/retry paths. */
const deadPlaneFactory: MessagePlaneFactory = (opts) => {
  opts.onStatus?.('connecting');
  return {
    get cursor() {
      return 0;
    },
    send: async () => {
      throw new SteemAuthError('plane-failed', 'not connected');
    },
    close: () => {},
  };
};

/** A scripted "mobile app" speaking the REAL v3 crypto over the same room. */
function mobileMock(room: string, key: string) {
  const received: SessionMessage[] = [];
  const waiters: Array<(m: SessionMessage) => void> = [];
  // At-most-once delivery per envelope: own sends are marked immediately, so
  // a join-time backlog (which fires on a macrotask and may lag behind this
  // mock's own traffic) can never re-deliver rows it produced or consumed.
  // The real client gets the same guarantee from its per-room seq cursor.
  const seen = new Set<string>();
  const plane = memoryRelayFactory({
    relayUrl: 'ws://memory.test',
    room,
    token: 'tok_phone_mock_0123456789abcdefghijklmnopqrstuv',
    onMessage: (payload) => {
      // Encrypt-then-MAC: anything failing the tag (wrong key, relay
      // injection, garbage) is dropped before decryption — same as the app.
      const envelope = payload as { c?: unknown };
      if (typeof envelope?.c === 'string') {
        if (seen.has(envelope.c)) return; // own send or already consumed
        seen.add(envelope.c);
      }
      const plain = mobileOpen(payload, key);
      if (!plain) return;
      if (waiters.length) waiters.shift()!(plain);
      else received.push(plain);
    },
  });
  return {
    waitJoined: () => Promise.resolve(), // the factory connects on the next tick
    next: (timeoutMs = 3000): Promise<SessionMessage> =>
      new Promise((res, rej) => {
        if (received.length) return res(received.shift()!);
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          res(m);
        });
      }),
    send(message: SessionMessage) {
      const sealed = mobileSeal(message as never, key);
      seen.add(sealed.c); // our own row — never re-delivered to us
      void plane.send(sealed).catch(() => {});
    },
    /** Raw envelope — injection / wrong-key probes need this. */
    sendRaw(envelope: SealedEnvelope) {
      seen.add(envelope.c);
      void plane.send(envelope).catch(() => {});
    },
    close: () => plane.close(),
  };
}


/** Poll until `fn()` is true (message delivery over the relay is async). */
function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('until(): timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main() {
  // Offline by design: the in-memory plane IS the transport (planeFactory).
  const TRANSPORT = { planeFactory: memoryRelayFactory } as const;

  // ---- 0. All-in-one: createQrSession connects + renders in one call -----
  const bundle = await createQrSession({
    appName: 'AllInOne',
    ...TRANSPORT,
    subscribeTimeoutMs: 5000,
  });
  check('createQrSession renders a displayable SVG QR', bundle.svg.includes('<svg'));
  check(
    'createQrSession renders a PNG data URL',
    bundle.dataUrl.startsWith('data:image/png;base64,'),
  );
  check('bundle QR encodes the session payload', bundle.qrString === bundle.session.qrString);
  check(
    'bundle session is live and waiting for a scan',
    bundle.session.connectionStatus === 'waiting',
    bundle.session.connectionStatus,
  );
  bundle.dispose();
  check(
    'bundle dispose tears the session down',
    bundle.session.connectionStatus === 'disconnected',
  );

  const statuses: ConnectionStatus[] = [];
  const session = new SteemAuthSession({
    appName: 'SteemPro',
    origin: 'https://steempro.com',
    ...TRANSPORT,
    requestTimeoutMs: 4000,
  });
  session.onStatus((s) => statuses.push(s));

  try {
    // ---- 1. Web side joins the relay --------------------------------------
    await session.connect();
    const mobile = mobileMock(session.payload.rm, session.payload.k);
    await mobile.waitJoined();

    // ---- 2. Mobile announces itself (ready) over the real socket ---------
    mobile.send({
      type: 'ready',
      sid: session.payload.sid,
      account: 'alice',
      authority: 'posting',
      device: 'test-device',
    });

    const ready = await session.waitForAccount();
    check(
      'ready travels relay → app over a real WebSocket',
      ready.account === 'alice' && ready.authority === 'posting',
      ready,
    );
    check('status listener saw ready', statuses.includes('ready'), statuses);
    check('session.account reflects ready info', session.account === 'alice');

    // ---- 3. Request → mobile validates → result comes back ---------------
    const pending = session.request({
      ...requestVote('alice', 'bob', 'hello-world', 100),
      description: 'Upvote a post',
    });

    const request = await mobile.next();
    check('mobile receives the request frame', request.type === 'request');
    if (request.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(request));
    check(
      'custom description travels as meta.description',
      request.meta?.description === 'Upvote a post',
      request.meta,
    );

    const validation = validateOperationBatch(request.ops, {
      expectedAccount: 'alice',
    });
    check(
      'real mobile validation accepts the request ops',
      validation.ok,
      validation.ok ? undefined : validation.error,
    );

    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: request.id,
      ok: true,
      txId: 'a'.repeat(40),
      account: 'alice',
    });

    const result = await pending;
    check(
      'approved request resolves with the broadcast txId',
      result.success === true && result.data?.txId === 'a'.repeat(40),
      result,
    );
    check('result echoes the method', result.method === 'requestVote');

    // ---- 3b. authenticate() — off-chain login challenge --------------------
    const authPending = session.authenticate({
      statement: 'Sign in to Test',
      nonce: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      expiresInMs: 60_000,
    });
    const authReq = await mobile.next();
    if (authReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(authReq));
    check(
      'authenticate sends sign.data with NO operations',
      !!authReq.sign && authReq.sign.data.length > 0 && authReq.ops.length === 0,
      { ops: authReq.ops.length, hasSign: !!authReq.sign },
    );
    check(
      'authenticate marks action=authenticate (app records a revocable session)',
      authReq.action === 'authenticate',
      authReq.action,
    );
    check(
      'challenge carries account, statement, nonce, session, origin and expiry',
      authReq.sign!.data.includes('Sign in to Test') &&
        authReq.sign!.data.includes('Nonce: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6') &&
        authReq.sign!.data.includes(`Session: ${session.payload.sid}`) &&
        authReq.sign!.data.includes('Origin: https://steempro.com') &&
        authReq.sign!.data.includes('Expires At:'),
      authReq.sign!.data,
    );
    const signature = 'a'.repeat(130);
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: authReq.id,
      ok: true,
      account: 'alice',
      signature,
    });
    const authResult = await authPending;
    check(
      'authenticate resolves with signature + challenge fields',
      authResult.success === true &&
        authResult.signature === signature &&
        authResult.nonce === 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' &&
        authResult.account === 'alice' &&
        authResult.message.includes('Sign in to Test') &&
        authResult.expiresAt > Date.now(),
      authResult,
    );

    // ---- 3c. Exclusive, custom expiry for authentication -------------------
    // The client's expiresInMs lands verbatim BOTH as the request's void-time
    // and as the challenge's Expires At (60s, not the QR's 5min default).
    check(
      'custom expiry is the request void-time on the wire',
      authReq.exp === authResult.expiresAt,
      { wire: authReq.exp, result: authResult.expiresAt },
    );
    const customIso = new Date(authResult.expiresAt).toISOString();
    check(
      'challenge shows the exact custom Expires At',
      authReq.sign!.data.includes(`Expires At: ${customIso}`),
      customIso,
    );
    check(
      'custom expiry honored (60s from issuance, not the 5-min default)',
      authResult.expiresAt - authResult.issuedAt === 60_000,
      authResult.expiresAt - authResult.issuedAt,
    );

    // An authorization window may legitimately OUTLIVE the QR session: the
    // proof is off-chain and the backend honors its own timestamps.
    const longPending = session.authenticate({
      expiresInMs: 15 * 60_000,
      statement: 'Long window',
    });
    const longReq = await mobile.next();
    if (longReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(longReq));
    check(
      'auth expiry may exceed the QR window (off-chain proof)',
      typeof longReq.exp === 'number' && longReq.exp > session.payload.exp,
      { authExp: longReq.exp, qrExp: session.payload.exp },
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: longReq.id,
      ok: true,
      account: 'alice',
      signature: 'b'.repeat(130),
    });
    const longResult = await longPending;
    check(
      'long expiry reported back untouched',
      longResult.success === true && longResult.expiresAt === longReq.exp,
      longResult.expiresAt,
    );

    // EXCLUSIVITY: other operations keep the QR's own window — the auth
    // expiry must never leak into them.
    const otherPending = session.request(requestVote('alice', 'bob', 'expiry-probe', 10));
    const otherReq = await mobile.next();
    if (otherReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(otherReq));
    check(
      'other requests keep the QR expiry (auth expiry is exclusive)',
      otherReq.exp === session.payload.exp,
      { otherExp: otherReq.exp, qrExp: session.payload.exp },
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: otherReq.id,
      ok: true,
      txId: 'ee'.repeat(20),
    });
    await otherPending;

    // Exclusivity is enforced at runtime too: even a smuggled `exp` on an
    // ordinary request (JS callers can lie past TypeScript) is ignored —
    // the wire always carries the QR window.
    const smuggledPending = session.request({
      username: 'alice',
      operations: [['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 1000 }]],
      exp: Date.now() + 60_000,
    } as never);
    const smuggledReq = await mobile.next();
    if (smuggledReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(smuggledReq));
    check(
      'a JS-level exp on a broadcast request cannot override the QR window',
      smuggledReq.exp === session.payload.exp,
      { wire: smuggledReq.exp, qr: session.payload.exp },
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: smuggledReq.id,
      ok: true,
      txId: 'ab'.repeat(20),
    });
    await smuggledPending;

    // A non-finite expiry must never reach the phone as "Invalid Date".
    let nanError = '';
    try {
      await session.authenticate({ expiresInMs: Number.NaN });
    } catch (e) {
      nanError = (e as Error).message;
    }
    check(
      'NaN expiresInMs refused client-side',
      nanError.includes('must be in the future'),
      nanError,
    );

    // ---- 4. Bad requests fail fast BEFORE anything hits the relay ---------
    let unsupportedError = '';
    let unsupportedCode = '';
    try {
      await session.request({ username: 'alice', operations: [['wormhole', { a: 1 }]] } as never);
    } catch (e) {
      unsupportedError = (e as Error).message;
      unsupportedCode = isSteemAuthError(e) ? e.code : '';
    }
    check(
      'unsupported operation fails fast client-side',
      unsupportedError.includes('Unsupported operation: wormhole'),
      unsupportedError,
    );
    check(
      'typed errors carry a machine-readable code',
      unsupportedCode === 'invalid-request',
      unsupportedCode,
    );
    let foreignError = '';
    try {
      await session.request(requestTransfer('bob', 'carol', '1'));
    } catch (e) {
      foreignError = (e as Error).message;
    }
    check(
      'request not involving the connected account fails fast client-side',
      foreignError.includes('Operations do not involve @alice'),
      foreignError,
    );
    let signGuard = '';
    try {
      await session.request({
        username: 'alice',
        operations: requestVote('alice', 'bob', 'x', 10).operations,
        sign: { data: 'both worlds' },
      });
    } catch (e) {
      signGuard = (e as Error).message;
    }
    check(
      'a sign request cannot also carry operations',
      signGuard.includes('cannot also carry operations'),
      signGuard,
    );
    let nonceError = '';
    try {
      await session.authenticate({ nonce: 'bad\nnonce' });
    } catch (e) {
      nonceError = (e as Error).message;
    }
    check(
      'authenticate refuses a nonce with line breaks (challenge injection guard)',
      nonceError.includes('printable ASCII without line breaks'),
      nonceError,
    );
    let pastError = '';
    try {
      await session.authenticate({ expiresAt: Date.now() - 1000 });
    } catch (e) {
      pastError = (e as Error).message;
    }
    check(
      'authenticate refuses an expiry in the past',
      pastError.includes('must be in the future'),
      pastError,
    );

    // ---- 5. Rejection path ------------------------------------------------
    const pending2 = session.request(requestTransfer('alice', 'bob', '5', 'nope'));
    const request2 = await mobile.next();
    if (request2.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(request2));
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: request2.id,
      ok: false,
      error: 'User rejected the request.',
    });
    const rejected = await pending2;
    check(
      'rejected request resolves with the user reason',
      rejected.success === false && rejected.error === 'User rejected the request.',
      rejected,
    );

    // ---- 6. Cancel path ---------------------------------------------------
    const pending3 = session.request(requestVote('alice', 'bob', 'x', 10));
    const request3 = await mobile.next();
    if (request3.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(request3));
    mobile.send({
      type: 'cancel',
      sid: session.payload.sid,
      id: request3.id,
      reason: 'Session ended',
    });
    const cancelled = await pending3;
    check(
      'cancel from the mobile side resolves as unsuccessful',
      cancelled.success === false && cancelled.error === 'Session ended',
      cancelled,
    );

    // ---- 7. Wrong-key ciphertext is ignored -------------------------------
    mobile.sendRaw({
      // A "relay-side injection" simulation: attacker-chosen ciphertext and
      // tag — HMAC verification drops it before any decryption happens.
      c: 'forged-ciphertext-not-sealed-by-any-peer',
      m: 'a'.repeat(64),
    });
    // Give the app a beat to (not) process it, then confirm nothing broke:
    const ping = session.request(requestVote('alice', 'bob', 'ping-me', 1));
    const pingReq = await mobile.next();
    if (pingReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(pingReq));
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: pingReq.id,
      ok: true,
      txId: 'b'.repeat(40),
    });
    const pingResult = await ping;
    check('session still healthy after foreign ciphertext', pingResult.success === true);
    check('garbage never triggers a failed status', !statuses.includes('failed'), statuses);

    // ---- 8. Room isolation: a stranger cannot observe or inject -----------
    const stranger = mobileMock(`${session.payload.rm}-decoy`, 'other-key');
    await stranger.waitJoined();
    stranger.send({
      type: 'ready',
      sid: session.payload.sid, // message claims our sid — but it was written to a different room
      account: 'mallory',
      authority: 'posting',
    });
    // The app must NOT see the stranger's ready (different room).
    let sawStranger = false;
    try {
      // pending3 was already resolved; use a fresh request to buy time
      const probe = session.request(requestVote('alice', 'bob', 'probe', 1));
      const probeReq = await mobile.next();
      if (probeReq.type === 'request') {
        mobile.send({
          type: 'result',
          sid: session.payload.sid,
          id: probeReq.id,
          ok: true,
          txId: 'c'.repeat(40),
        });
      }
      const probeResult = await probe;
      sawStranger = probeResult.account === 'mallory';
      check('room isolation holds for a same-sid stranger', !sawStranger, {
        account: probeResult.account,
      });
    } finally {
      stranger.close();
    }

    // ---- 9. Session convenience actions auto-fill the connected account ---
    const votePending = session.vote('bob', 'convenience', 10);
    const voteReq = await mobile.next();
    if (voteReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(voteReq));
    check(
      'session.vote auto-uses the connected account',
      voteReq.type === 'request' &&
        ((voteReq.ops[0]![1] as { voter?: string }).voter === 'alice'),
      voteReq.ops,
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: voteReq.id,
      ok: true,
      txId: 'd'.repeat(40),
    });
    const voteResult = await votePending;
    check('session.vote resolves like request()', voteResult.success === true);

    const transferPending = session.transfer('bob', '1.5', 'auto');
    const transferReq = await mobile.next();
    if (transferReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(transferReq));
    const transferOp = transferReq.ops[0]![1] as { from?: string; amount?: string };
    check(
      'session.transfer auto-fills from + normalizes amount',
      transferOp.from === 'alice' && transferOp.amount === '1.500 STEEM',
      transferOp,
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: transferReq.id,
      ok: true,
      txId: 'e'.repeat(40),
    });
    await transferPending;

    // The generic typed action API is an alias for the same registry.
    const genericPending = session.action('vote', 'bob', 'via-generic', 10);
    const genericReq = await mobile.next();
    if (genericReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(genericReq));
    check(
      'session.action("vote", …) routes through the shared registry',
      (genericReq.ops[0]![1] as { voter?: string }).voter === 'alice',
      genericReq.ops,
    );
    mobile.send({
      type: 'result',
      sid: session.payload.sid,
      id: genericReq.id,
      ok: true,
      txId: 'e2'.repeat(20),
    });
    await genericPending;

    // Acting before the phone scans must fail with a descriptive error.
    const early = new SteemAuthSession({ appName: 'Early', ...TRANSPORT });
    let earlyError = '';
    let earlyCode = '';
    try {
      await early.vote('bob', 'x', 10);
    } catch (e) {
      earlyError = (e as Error).message;
      earlyCode = isSteemAuthError(e) ? e.code : '';
    }
    check(
      'actions before a scan throw a descriptive error',
      earlyError.includes('No authenticator connected yet'),
      earlyError,
    );
    check(
      "pre-scan action errors carry code 'no-account'",
      earlyCode === 'no-account',
      earlyCode,
    );
    early.dispose();

    // ---- 10. Controller: reactive state + zero-boilerplate actions --------
    const ctl = new SteemAuthController({
    appName: 'Ctl',
    ...TRANSPORT,
    subscribeTimeoutMs: 5000,
  });
    const statusesSeen: string[] = [];
    ctl.subscribe(() => statusesSeen.push(ctl.getState().status));
    await ctl.start();
    check(
      'controller reaches waiting with a rendered QR',
      ctl.getState().status === 'waiting' && (ctl.getState().qr?.svg.includes('<svg') ?? false),
      ctl.getState(),
    );
    check('controller loading clears once the QR is shown', ctl.getState().loading === false);

    const phone2 = mobileMock(ctl.session!.payload.rm, ctl.session!.payload.k);
    await phone2.waitJoined();
    phone2.send({
      type: 'ready',
      sid: ctl.session!.payload.sid,
      account: 'alice',
      authority: 'posting',
    });
    const waitForCtl = () =>
      new Promise<void>((res) => {
        if (ctl.getState().account) return res();
        const unsub = ctl.subscribe(() => {
          if (ctl.getState().account) {
            unsub();
            res();
          }
        });
      });
    await waitForCtl();
    check('controller reports the connected account', ctl.getState().account === 'alice');
    check('controller ready flag flips', ctl.getState().ready === true);

    const ctlPending = ctl.vote('bob', 'via-controller', 25);
    check('controller tracks requesting while pending', ctl.getState().requesting === true);
    const ctlReq = await phone2.next();
    if (ctlReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(ctlReq));
    phone2.send({
      type: 'result',
      sid: ctl.session!.payload.sid,
      id: ctlReq.id,
      ok: true,
      txId: 'f'.repeat(40),
    });
    const ctlResult = await ctlPending;
    check(
      'controller action resolves with the Keychain result',
      ctlResult?.success === true && ctl.getState().requesting === false,
      ctlResult,
    );

    // The user revokes the app on the phone → controller surfaces it, and a
    // subsequent action fails with the reason (never hangs, never sends).
    phone2.send({
      type: 'revoke',
      sid: ctl.session!.payload.sid,
      reason: 'Access was revoked in the authenticator.',
    });
    await until(() => ctl.getState().status === 'revoked');
    check('controller surfaces the revoked status', ctl.getState().status === 'revoked');
    const ctlPostRevoke = await ctl.vote('bob', 'after-revoke', 10);
    check(
      'controller action after revoke returns null + surfaces the reason',
      ctlPostRevoke === null &&
        (ctl.getState().error ?? '').includes('revoked in the authenticator'),
      ctl.getState().error,
    );
    check(
      "controller state carries errorCode 'revoked'",
      ctl.getState().errorCode === 'revoked',
      ctl.getState().errorCode,
    );

    const oldSid = ctl.session!.payload.sid;
    await ctl.refresh();
    check(
      'controller refresh recovers with a fresh session + QR after revoke',
      ctl.getState().account === null &&
        ctl.getState().qr !== null &&
        ctl.session!.payload.sid !== oldSid &&
        ctl.getState().status !== 'revoked',
      ctl.getState(),
    );
    check('controller status history captured', statusesSeen.includes('waiting'), statusesSeen);
    ctl.dispose();
    check('controller dispose marks disposed', ctl.getState().disposed === true);
    phone2.close();

    // ---- 11. Revoke: the user removes this app on the phone ---------------
    const doomed = session.request(requestVote('alice', 'bob', 'doomed', 10));
    const doomedReq = await mobile.next();
    if (doomedReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(doomedReq));
    mobile.send({
      type: 'revoke',
      sid: session.payload.sid,
      reason: 'Access was revoked in the authenticator.',
    });
    const doomedResult = await doomed;
    check(
      'pending request resolves as unsuccessful on revoke',
      doomedResult.success === false &&
        doomedResult.error === 'Access was revoked in the authenticator.',
      doomedResult,
    );
    check('status flips to revoked', session.connectionStatus === 'revoked', session.connectionStatus);
    check(
      'isRevoked + revocationReason surfaced',
      session.isRevoked === true && session.revocationReason !== null,
    );
    let afterRevoke = '';
    let afterRevokeCode = '';
    try {
      await session.request(requestVote('alice', 'bob', 'late', 10));
    } catch (e) {
      afterRevoke = (e as Error).message;
      afterRevokeCode = isSteemAuthError(e) ? e.code : '';
    }
    check(
      'requests after revoke fail fast with the revoke reason',
      afterRevoke.includes('revoked in the authenticator'),
      afterRevoke,
    );
    check(
      'revoked-session errors carry code "revoked"',
      afterRevokeCode === 'revoked',
      afterRevokeCode,
    );
    let waitAfterRevoke = '';
    try {
      await session.waitForAccount();
    } catch (e) {
      waitAfterRevoke = (e as Error).message;
    }
    check(
      'waitForAccount REJECTS after revoke instead of hanging',
      waitAfterRevoke.includes('revoked'),
      waitAfterRevoke,
    );
    let connectAfterRevoke = '';
    try {
      await session.connect();
    } catch (e) {
      connectAfterRevoke = (e as Error).message;
    }
    check(
      'connect() refuses to resurrect a revoked session',
      connectAfterRevoke.includes('revoked'),
      connectAfterRevoke,
    );

    // ---- 12. Dispose closes cleanly ----------------------------------------
    session.dispose();
    check('dispose marks the session disconnected', session.connectionStatus === 'disconnected');
    let disposedThrew = false;
    try {
      await session.request(requestVote('alice', 'bob', 'late', 1));
    } catch {
      disposedThrew = true;
    }
    check('requests after dispose reject immediately', disposedThrew);
    mobile.close();

    // ---- 13. connect() against an unreachable relay -----------------------
    // Must reject — and a RETRY must not falsely resolve before the room is
    // live (regression: a timed-out attempt used to leave the session
    // pretending it was connected).
    const dead = new SteemAuthSession({
      appName: 'DeadRelay',
      ...TRANSPORT,
      planeFactory: deadPlaneFactory,
      subscribeTimeoutMs: 700,
    });
    let deadError = '';
    try {
      await dead.connect();
    } catch (e) {
      deadError = (e as Error).message;
    }
    check(
      'connect() rejects when the plane never connects',
      deadError.includes('Timed out joining the relay room'),
      deadError,
    );
    const retryOutcome = await Promise.race([
      dead
        .connect()
        .then(() => 'resolved' as const)
        .catch(() => 'rejected' as const),
      new Promise((r) => setTimeout(() => r('pending' as const), 300)),
    ]);
    check(
      'retry does not falsely resolve before the room is live',
      retryOutcome !== 'resolved',
      retryOutcome,
    );
    dead.dispose();

    // ---- 14. persistSession + resume: a refresh must NOT kill the session --
    const memStore = (() => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      };
    })();
    const persistOpts = {
      appName: 'Persist',
      ...TRANSPORT,
      storage: memStore,
      persistSession: true,
      subscribeTimeoutMs: 5000,
    };

    const first = new SteemAuthSession(persistOpts);
    await first.connect();
    const phone3 = mobileMock(first.payload.rm, first.payload.k);
    await phone3.waitJoined();
    phone3.send({
      type: 'ready',
      sid: first.payload.sid,
      account: 'alice',
      authority: 'posting',
    });
    await first.waitForAccount();

    const abandoned = first.request(requestVote('alice', 'bob', 'in-flight', 10));
    void abandoned.catch(() => {
      /* the dead page's promise — settles via timer, nothing listens */
    });
    const originalReq = await phone3.next();
    if (originalReq.type !== 'request') throw new Error('UNEXPECTED: ' + JSON.stringify(originalReq));
    const saved = memStore.getItem('steemauth.qr.session') ?? '';
    check(
      'persistSession stores the session + in-flight request',
      saved.includes(first.payload.sid) && saved.includes(originalReq.id),
      { sid: first.payload.sid, id: originalReq.id },
    );

    // Simulate the page dying: the socket goes away WITHOUT dispose() —
    // that is exactly what a refresh is, and storage must survive it.
    (first as unknown as { teardownPlane(): void }).teardownPlane();

    const resumed = await SteemAuthSession.resume(persistOpts);
    check('resume() rebuilds the SAME session', resumed !== null && resumed!.payload.sid === first.payload.sid);
    check('resume() restores the handshake (account, no re-scan)', resumed?.account === 'alice');
    check('resume() restores status ready without a new scan', resumed?.connectionStatus === 'ready');

    const restored = resumed!.restoredRequest;
    check('resume() exposes the re-issued request', restored !== null);
    const reissued = await phone3.next(); // phone never left the room
    check(
      'in-flight request re-issued with the SAME id',
      reissued.type === 'request' && reissued.id === originalReq.id,
      { original: originalReq.id, reissued: reissued.type === 'request' ? reissued.id : reissued.type },
    );
    phone3.send({
      type: 'result',
      sid: resumed!.payload.sid,
      id: reissued.type === 'request' ? reissued.id : 'x',
      ok: true,
      txId: 'd'.repeat(40),
    });
    const restoredResult = await restored!;
    check(
      'restoredRequest resolves with the outcome after resume',
      restoredResult.success === true && restoredResult.data?.txId === 'd'.repeat(40),
      restoredResult,
    );
    const afterSettle = memStore.getItem('steemauth.qr.session') ?? '';
    check(
      'storage drops the pending entry once settled',
      !afterSettle.includes(originalReq.id),
      afterSettle.slice(0, 120),
    );

    resumed!.dispose();
    first.dispose();
    phone3.close();
  } finally {
    // offline harness — no server to shut down
  }

  console.log(
    failures === 0 ? '\nAll e2e checks passed ✔' : `\n${failures} e2e check(s) FAILED ✘`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E test crashed:', e);
  process.exit(1);
});
