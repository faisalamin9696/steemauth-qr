# Sessions — the lifecycle

`SteemAuthSession` is the core object: one QR, one message stream, one phone.
The controller ([react.md](react.md)) and `createQrSession()` wrap it; this
page is everything it does.

## Creating

```ts
import { SteemAuthSession } from "@steempro/steemauth-qr";

const session = new SteemAuthSession({
  appName: "My dApp",            // required — shown on the phone
  origin: window.location.origin, // informational (`url` field)
  // src (verified origin) is captured automatically — not an option
  relayUrl: undefined,            // default: shared global relay
  ttlMs: 300_000,                 // QR lifetime (min 30_000)
  requestTimeoutMs: undefined,    // default: QR TTL
  subscribeTimeoutMs: 15_000,     // relay-join timeout
});
```

Construction generates `sid` + `k` from WebCrypto and validates options
(typed errors: `appName is required…`, `ttlMs must be at least 30 seconds`;
`relayUrl` must be ws(s):// when given).

## Connecting

```ts
await session.connect();   // resolves when the relay room is LIVE
showQr(session.qrString);
```

- Idempotent (concurrent calls share one attempt); **retryable** after a
  failure — the failed transport is torn down first.
- Rejects with `plane-timeout` after `subscribeTimeoutMs`, `revoked` if the
  user revoked the app, `disposed` after `dispose()`.
- Call it **before** showing the QR: the phone's single `ready` announcement
  races anything you send first.

## Status

```ts
const off = session.onStatus((s) => render(s));   // fires immediately, then on change
```

```
connecting ──▶ waiting ──▶ ready            phone scans (waitForAccount resolves)
    │            │
    │            └──(QR expires / user closes app)──▶  create a NEW session
    ├──▶ failed      plane unreachable (connect() threw)
    ├──▶ revoked     user revoked this app — session over (see revocation.md)
    └──▶ disconnected  dispose() called, or relay closed
```

Getters: `session.connectionStatus`, `session.account` (`string | null`),
`session.isRevoked`, `session.revocationReason`, `session.pendingCount`,
`session.expiresAt`, `session.payload`.

## The account handshake

```ts
const { account, authority, device } = await session.waitForAccount();
```

Resolves when the phone scans and selects an account; **rejects** after a
revocation (it can never produce an account again). Then any
account-defaulted action works: `session.vote("bob", "p", 100)`.

## Sending requests

`request(req)` — see [operations](operations.md) for shapes and results.
Guarantees:

- validated first — typed `invalid-request` errors carry the phone's exact
  wording;
- `revoked` / `session-expired` / `not-connected` fail fast with codes;
- one promise per request; `cancel(id?)` resolves pending ones as cancelled;
- `ping()` sends an optional keepalive (the phone answers automatically).

## Sign-ins on the same session

`signBuffer(data, keyType?)` and `authenticate(options?)` (see
[authentication](authentication.md)) share the session — after a sign-in the
same session can still broadcast, until expiry/revocation/dispose.

## Disposing

```ts
session.dispose();
```

Leaves the message stream, rejects pending requests (`disposed`), stops the
revocation watch, wakes join waiters and marks `disconnected`. Idempotent.
Always dispose when the UI unmounts or the flow ends — it's what makes the
QR stop being answerable.

## Patterns

**QR refresh (expiry)**
```ts
if (Date.now() >= session.expiresAt) { session.dispose(); /* new session */ }
```

**Reject → fresh QR** — a rejection closes the phone side; rebuild the
session before the next action.

**One session, many actions** — approved requests keep the session alive;
batch or sequence as many as the user will tolerate.

**Refresh survival (`persistSession`)**

A refresh normally kills a session — the room state lived in memory. With
`persistSession: true` the snapshot (sid/key/handshake + in-flight request)
goes to `sessionStorage`, bounded by the QR TTL and cleared by
`dispose()`:

```ts
const session = await SteemAuthSession.resume({ appName: "My dApp" });
if (session) {
  // same room — the phone never noticed the refresh
  session.restoredRequest?.then((r) => console.log("in-flight outcome:", r));
} else {
  // nothing resumable (expired / first visit) — show a fresh QR
}
```

The controller and the hook do this automatically: set
`persistSession: true` in the options and `start()` resumes before minting a
new session. `controller.restoredRequest` exposes the re-issued request.
Resume restores the account (no second scan), the relay room and the
revocation watch, and re-sends the pending request **with the same id** —
receivers key pending state by id, so it's a re-show, not a duplicate.

## Next

- [Operations](operations.md) · [Authentication](authentication.md) ·
  [Revocation](revocation.md) · [Errors](errors.md)
