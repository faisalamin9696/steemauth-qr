# Revocation — when the user says stop

Users can remove an app from the authenticator's **Sessions** tab at any
time. The package detects that and kills the session on every path, so a
revoked app can never keep signing.

## Why it's airtight in v3

The room **is** the session. Revocation is a sealed `revoke` row in the
room log, and the transport itself enforces the rest:

| Layer | Path | Catches |
|---|---|---|
| 1. Live row | the `revoke` row is pushed to every member the moment it lands | live revocations, immediately |
| 2. Replay | the room log keeps the row; any reconnect/refresh pulls `seq > cursor` | revocations that happen while the app was offline or between reconnects |
| 3. The room itself | requests can only ride the room — once it's gone (revoked + closed by the phone, or swept after idle), there is no path to the phone at all | anything a lost row could theoretically miss |

There is no third-party control plane to configure and no row-watch to
break: the same durable log that carries requests carries the revoke, and
its lifetime is exactly the session's lifetime.

## What the package does on revocation

One idempotent path (`applyRevocation`) for every layer:

- every **pending request** resolves `{ success: false, error: <reason> }`;
- **`waitForAccount()` waiters reject** (no hanging, ever);
- status → **`revoked`**; `isRevoked` → true, `revocationReason` → the reason;
- new `request()`/actions fail fast with the typed `revoked` code;
- `connect()` refuses to resurrect the session;
- the relay plane is torn down.

```ts
session.onStatus((s) => {
  if (s === "revoked") showBanner(session.revocationReason!);
});
// or branch on errors:
try {
  await session.vote("bob", "p", 10);
} catch (e) {
  if (isSteemAuthError(e) && e.code === "revoked") rebuildSession();
}
```

## Recovering

A revoked session is **over** — build a fresh one. The QR, the room and the
key are all bound to the dead session:

```ts
session.dispose();
const auth = await createQrSession({ appName: "My dApp" });   // new QR
```

In React, `auth.refresh()` does the same from the hook.

> Note: for a **broadcast** request the phone ends the session after a
> rejection too. Revocation is different: it's global — the *user* decided,
> from the Sessions tab, that this app is done. The phone may also close
> the room (`close`), deleting its log immediately.

## Testing it yourself

```ts
// any side can send the row — here's what the phone sends:
session["handleMessage"]({ c: encryptMessage(
  { type: "revoke", sid: session.payload.sid, reason: "Access was revoked in the authenticator." },
  session.payload.k,
), m: hmacHex(/* … */) });
```

…or revoke from the phone's Sessions tab and watch `status === "revoked"`
land. Both suites prove the chain end-to-end offline (`verify-e2e`) and
against a REAL relay (`verify-relay-plane` — revoke row, pending resolved,
fail-fast afterwards) — no credentials needed.

## Next

- [Sessions](sessions.md) · [Errors](errors.md) · [Security](security.md)
