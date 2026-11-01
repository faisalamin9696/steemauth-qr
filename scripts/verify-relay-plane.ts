/**
 * LIVE relay-plane suite — boots a REAL steemauth-relay (in-process) and
 * drives it over REAL WebSockets. No credentials, no Supabase: the relay is
 * the plane, so this suite runs in every `npm test`.
 *
 *   1. full session loop: real SteemAuthSession (real createRelayPlane)
 *      ⇄ a phone speaking the REAL mobile app's crypto — ready → request →
 *      result → revoke, all as sealed rows in the room log
 *   2. replay/page-death: a resumed session re-joins, replays the backlog
 *      and re-issues an in-flight request with the SAME id
 *   3. SECURITY: bad tokens refused (+ IP ban), phone token rotation
 *      invalidates the old token, forged envelopes (bad MAC) dropped by the
 *      REAL mobile crypto, oversized envelopes refused, rooms isolated
 *
 * Run: npx tsx scripts/verify-relay-plane.ts
 */
import { createRelayServer } from '../../steemauth-relay/server.js';
import { SteemAuthSession } from '../src/session';
import {
  createRelayPlane,
  MAX_ENVELOPE_BYTES,
  type MessagePlane,
} from '../src/relay-plane';
import {
  generateRoom,
  generateToken,
  sha256Hex,
  type SealedEnvelope,
} from '../src/protocol';
import { requestVote } from '../src/requests';
import type { SessionMessage } from '../src/types';

import { mobile } from './mobile';

// The REAL mobile app implementation (pure TS), resolved from the live
// checkout via scripts/mobile.ts — including its v3 seal/open (HMAC).
const { sealMessage: mobileSeal, openMessage: mobileOpen } = mobile.protocol;

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('      ', JSON.stringify(extra));
  }
}

/** Raw relay client for security probes (frames, not the plane client). */
const WebSocketImpl = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
function rawClient(url: string) {
  const ws = new WebSocketImpl(url);
  const inbox: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (waiters.length) waiters.shift()!(msg);
    else inbox.push(msg);
  };
  return {
    ws,
    open: new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket error'));
    }),
    send(obj: unknown) {
      ws.send(JSON.stringify(obj));
    },
    next(timeoutMs = 4000): Promise<any> {
      return new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        const t = setTimeout(() => reject(new Error('timeout waiting for relay frame')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    },
    closed: new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code);
    }),
    close() {
      ws.close();
    },
  };
}

/** A scripted "phone" on the real relay, speaking the REAL app crypto. */
function phoneOnRoom(url: string, room: string, token: string, key: string) {
  const received: SessionMessage[] = [];
  const waiters: Array<(m: SessionMessage) => void> = [];
  const plane: MessagePlane = createRelayPlane({
    relayUrl: url,
    room,
    token,
    onMessage: (payload) => {
      const plain = mobileOpen(payload, key);
      if (!plain) return;
      if (waiters.length) waiters.shift()!(plain);
      else received.push(plain);
    },
  });
  return {
    plane,
    next(timeoutMs = 5000): Promise<SessionMessage> {
      return new Promise((resolve, reject) => {
        if (received.length) return resolve(received.shift()!);
        const t = setTimeout(() => reject(new Error('timeout: phone saw no message')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    },
    send(message: SessionMessage) {
      return plane.send(mobileSeal(message as never, key));
    },
    sendRaw(envelope: SealedEnvelope) {
      return plane.send(envelope);
    },
    close: () => plane.close(),
  };
}

async function main() {
  const relay = createRelayServer({
    // Keep the sweeper out of the way; room caps stay at defaults.
    roomIdleMs: 30 * 60_000,
    sweepIntervalMs: 60_000,
  });
  const port = await relay.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${port}`;

  try {
    // ---- 1. Full loop over the REAL relay + REAL crypto --------------------
    const session = new SteemAuthSession({
      appName: 'RelayPlane',
      requestTimeoutMs: 8000,
      subscribeTimeoutMs: 5000,
      relayUrl: url,
    });
    await session.connect();
    check('connect(): room registered (hashed tokens) + joined', session.connectionStatus === 'waiting', session.connectionStatus);
    check('QR carries v3 rendezvous fields (rt/rm/tk)', session.payload.v === 3 && session.payload.rt === url && /^rm_/.test(session.payload.rm) && /^tok_/.test(session.payload.tk), { v: session.payload.v });

    const phone = phoneOnRoom(url, session.payload.rm, session.payload.tk, session.payload.k);
    await phone.send({ type: 'ready', sid: session.payload.sid, account: 'alice', authority: 'posting' });
    const ready = await session.waitForAccount();
    check('ready row (real app crypto, real socket) restores the account', ready.account === 'alice');

    const pending = session.request(requestVote('alice', 'bob', 'via-relay', 50));
    const req = await phone.next();
    if (req.type !== 'request') throw new Error('unreachable');
    check('request arrives at the phone over the live relay', req.type === 'request', { type: req.type });
    check('mobile op validation accepts the request ops', validateMobile(req));

    await phone.send({ type: 'result', sid: session.payload.sid, id: req.id, ok: true, txId: 'c'.repeat(40), account: 'alice' });
    const result = await pending;
    check('result row resolves the pending request', result.success === true && result.data?.txId === 'c'.repeat(40));

    // ---- 2. Resume: page death → rejoin → replay → re-issue ----------------
    const memStore = memStorage();
    const opts = {
      appName: 'ResumeLive',
      relayUrl: url,
      persistSession: true,
      storage: memStore,
      requestTimeoutMs: 8000,
      subscribeTimeoutMs: 5000,
    } as const;
    const first = new SteemAuthSession(opts);
    await first.connect();
    const phone2 = phoneOnRoom(url, first.payload.rm, first.payload.tk, first.payload.k);
    await phone2.send({ type: 'ready', sid: first.payload.sid, account: 'alice', authority: 'posting' });
    await first.waitForAccount();

    // In-flight request when the "page dies" (plane torn down, snapshot kept).
    const inFlight = first.request(requestVote('alice', 'bob', 'restore-me', 20));
    inFlight.catch(() => {});
    const originalReq = await phone2.next();
    if (originalReq.type !== 'request') throw new Error('unreachable');
    (first as unknown as { teardownPlane(): void }).teardownPlane();

    const resumed = await SteemAuthSession.resume(opts);
    check('resume() re-joins the same room', resumed !== null && resumed!.payload.rm === first.payload.rm, resumed?.payload.rm);
    if (resumed) {
      const restoredReady = await resumed.waitForAccount();
      check('backlog replay restores the account after "refresh"', restoredReady.account === 'alice');
      const reissued = await phone2.next();
      if (reissued.type !== 'request') throw new Error('unreachable');
      check('in-flight request re-issued with the SAME id', reissued.id === originalReq.id, { was: originalReq.id, now: reissued.id });
      await phone2.send({ type: 'result', sid: resumed.payload.sid, id: reissued.id, ok: true, txId: 'd'.repeat(40) });
      const restored = await resumed.restoredRequest;
      check('restoredRequest resolves with the fresh result', restored?.success === true && restored?.data?.txId === 'd'.repeat(40));
      resumed.dispose();
    }

    // ---- 3. SECURITY -------------------------------------------------------

    // 3a. Bad token: join refused, and repeated failures ban the IP.
    {
      const probe = rawClient(url);
      await probe.open;
      probe.send({ t: 'join', room: session.payload.rm, tok: generateToken() });
      check('wrong room token is refused (bad_token)', (await probe.next()).code === 'bad_token');
      // Four more failures trip the per-IP ban (5) → close(4010). Frames may
      // race the close, so we await the close itself, not per-frame replies.
      for (let i = 0; i < 4; i++) {
        probe.send({ t: 'join', room: session.payload.rm, tok: generateToken() });
      }
      const banned = (await probe.closed) === 4010;
      check('repeated auth failures ban the IP (close 4010)', banned);
      // NOTE: the ban (10 min) applies to 127.0.0.1 for the REST of this
      // suite — so security probes that still need to connect run FIRST
      // in a fresh relay below. (Sessions above are unaffected — already
      // connected.)
    }
  } finally {
    await relay.close();
  }

  // ---- 3b. Fresh relay: rotation + injection + isolation + caps -----------
  const relay2 = createRelayServer({ roomIdleMs: 30 * 60_000, sweepIntervalMs: 60_000 });
  const port2 = await relay2.listen(0, '127.0.0.1');
  const url2 = `ws://127.0.0.1:${port2}`;
  try {
    // 3b-i. Rotation: app rotates the phone token; the old one dies.
    {
      const appTok = generateToken();
      const phoneTok = generateToken();
      const room = generateRoom();
      const app = rawClient(url2);
      await app.open;
      app.send({ t: 'create', room, toks: [sha256Hex(appTok), sha256Hex(phoneTok)] });
      check('room registration acked', (await app.next()).t === 'ok');
      app.send({ t: 'rotate' });
      const rotated = await app.next();
      check('app token rotates the phone token', rotated.t === 'ok' && /^tok_/.test(rotated.tok));

      const old = rawClient(url2);
      await old.open;
      old.send({ t: 'join', room, tok: phoneTok });
      check('old phone token is dead after rotation', (await old.next()).code === 'bad_token');

      const fresh = rawClient(url2);
      await fresh.open;
      fresh.send({ t: 'join', room, tok: rotated.tok });
      check('rotated phone token joins', (await fresh.next()).t === 'ok');

      // Phone token may NOT rotate or close (scope separation).
      fresh.send({ t: 'rotate' });
      check('phone token cannot rotate (not_app)', (await fresh.next()).code === 'not_app');
      app.send({ t: 'close' });
      check('app close drops members (4000)', (await fresh.closed) === 4000);
    }

    // 3b-ii. Forged envelopes are dropped by the REAL mobile crypto.
    {
      const session = new SteemAuthSession({ appName: 'Forged', relayUrl: url2, requestTimeoutMs: 4000, subscribeTimeoutMs: 4000 });
      await session.connect();
      const phone = phoneOnRoom(url2, session.payload.rm, session.payload.tk, session.payload.k);
      await phone.send({ type: 'ready', sid: session.payload.sid, account: 'alice', authority: 'posting' });
      await session.waitForAccount();

      // Relay-side injection simulation: valid shape, bogus tag + garbage.
      await phone.sendRaw({ c: 'attacker-ciphertext', m: '0'.repeat(64) });
      // And one with a REAL ciphertext but a forged tag.
      const legit = mobileSeal({ type: 'ping', sid: session.payload.sid } as never, session.payload.k);
      await phone.sendRaw({ c: legit.c, m: 'f'.repeat(64) });
      await new Promise((r) => setTimeout(r, 150));

      check('forged envelopes never surface (session still healthy)', session.connectionStatus === 'ready', session.connectionStatus);

      // The session still works after the injection attempt.
      const pending = session.request(requestVote('alice', 'bob', 'still-alive', 10));
      const req = await phone.next();
      if (req.type !== 'request') throw new Error('unreachable');
      await phone.send({ type: 'result', sid: session.payload.sid, id: req.id, ok: true, txId: 'e'.repeat(40) });
      check('requests still flow after injection attempts', (await pending).success === true);
      session.dispose();
      phone.close();
    }

    // 3b-iii. Oversized envelopes are refused client-side (never hit relay).
    {
      const plane = createRelayPlane({
        relayUrl: url2,
        room: generateRoom(),
        token: generateToken(),
        onMessage: () => {},
      });
      let code = '';
      try {
        await plane.send({ c: 'x'.repeat(MAX_ENVELOPE_BYTES + 1), m: 'a'.repeat(64) });
      } catch (e) {
        code = (e as { code?: string }).code ?? '';
      }
      check('oversized envelope refused before the socket (invalid-request)', code === 'invalid-request', code);
      plane.close();
    }

    // 3b-iv. Rooms are isolated: a stranger in another room sees nothing.
    {
      const session = new SteemAuthSession({ appName: 'Isolated', relayUrl: url2, requestTimeoutMs: 4000, subscribeTimeoutMs: 4000 });
      await session.connect();
      const phone = phoneOnRoom(url2, session.payload.rm, session.payload.tk, session.payload.k);
      await phone.send({ type: 'ready', sid: session.payload.sid, account: 'alice', authority: 'posting' });
      await session.waitForAccount();

      // A DIFFERENT room: its members must never receive our rows.
      const strangerRoom = generateRoom();
      const appTokStranger = generateToken();
      const phoneTokStranger = generateToken();
      const strApp = rawClient(url2);
      await strApp.open;
      strApp.send({ t: 'create', room: strangerRoom, toks: [sha256Hex(appTokStranger), sha256Hex(phoneTokStranger)] });
      await strApp.next();

      const pending = session.request(requestVote('alice', 'bob', 'isolation', 10));
      const req = await phone.next();
      if (req.type !== 'request') throw new Error('unreachable');
      strApp.send({ t: 'pull', cursor: 0 });
      const rows = await strApp.next();
      check('other rooms never see our rows', rows.t === 'rows' && rows.rows.length === 0, rows.rows?.length);

      await phone.send({ type: 'result', sid: session.payload.sid, id: req.id, ok: true, txId: 'f'.repeat(40) });
      await pending;
      session.dispose();
      phone.close();
    }

    // 3b-v. Revocation rides the room log — replay makes it durable.
    {
      const session = new SteemAuthSession({ appName: 'RevokeLive', relayUrl: url2, requestTimeoutMs: 4000, subscribeTimeoutMs: 4000 });
      await session.connect();
      const phone = phoneOnRoom(url2, session.payload.rm, session.payload.tk, session.payload.k);
      await phone.send({ type: 'ready', sid: session.payload.sid, account: 'alice', authority: 'posting' });
      await session.waitForAccount();
      const pending = session.request(requestVote('alice', 'bob', 'doomed', 10));
      pending.catch(() => {});
      const req = await phone.next();
      if (req.type !== 'request') throw new Error('unreachable');
      void req;
      await phone.send({ type: 'revoke', sid: session.payload.sid, reason: 'user pulled access' });
      const outcome = await pending;
      check('revoke row resolves pending as failed with the reason', outcome.success === false && outcome.error === 'user pulled access', outcome.error);
      check('session status flips to revoked', session.connectionStatus === 'revoked', session.connectionStatus);
      let failCode = '';
      try {
        await session.request(requestVote('alice', 'bob', 'after-revoke', 10));
      } catch (e) {
        failCode = (e as { code?: string }).code ?? '';
      }
      check('requests after revoke fail fast (revoked)', failCode === 'revoked', failCode);
      session.dispose();
      phone.close();
    }
  } finally {
    await relay2.close();
  }

  console.log(failures === 0 ? '\nAll relay-plane checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

function validateMobile(req: Extract<SessionMessage, { type: 'request' }>): boolean {
  const { validateOperationBatch } = mobile.decoder;
  const validation = validateOperationBatch(req.ops, { expectedAccount: 'alice' });
  return validation.ok === true;
}

/** Minimal sessionStorage-compatible in-memory store. */
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

void main().catch((e) => {
  console.error('relay-plane test crashed:', e);
  process.exit(1);
});
