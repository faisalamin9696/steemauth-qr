# Quick start

From nothing to a user-approved Steem transaction. One call builds the
session, subscribes to its message stream and renders the QR — SVG **and** PNG.

## The whole flow

```ts
import { createQrSession, requestTransfer } from "@steempro/steemauth-qr";

// 1. Session + live message stream + rendered QR — one await
const auth = await createQrSession({
  appName: "My dApp",                      // shown on the phone
  origin: window.location.origin,          // informational
});

// 2. Display the QR — `svg` is a standalone <svg> string
document.getElementById("qr")!.innerHTML = auth.svg;
// …or: <img src={auth.dataUrl}>   …or render auth.qrString with any QR library

// 3. React when the phone scans (the phone announces itself instantly)
auth.session.onStatus((s) => console.log("authenticator:", s));
//    "connecting" → "waiting" → "ready"     (or "failed" / "disconnected")

const { account } = await auth.session.waitForAccount();
console.log(`@${account} scanned the QR`);

// 4. Request an action — auto-fills the connected account
const result = await auth.session.transfer("bob", "1.500", "thanks!");

if (result.success) {
  console.log("broadcast tx:", result.data?.txId);   // 40-char tx id
} else {
  console.error("rejected:", result.error);          // user pressed reject
}

// 5. Clean up when your flow ends
auth.dispose();
```

> ⚠️ **`createQrSession` resolves only when the relay room is live** — never
> show a QR before that, or you can miss the phone's `ready` announcement.
> If the relay is unreachable it throws after `subscribeTimeoutMs` (15 s).

## What just happened

1. A random session id (`sid`) and 32-byte AES key (`k`) were generated from
   WebCrypto and encoded into the QR — along with the relay URL and your
   page's **verified origin** (captured from `window.location.origin`, not
   settable).
2. The browser created the relay room `rm` and joined it with its own token
   before the QR was rendered.
3. The phone scanned, validated the payload (version, TTL, chain), joined the
   same room and sent `ready` — encrypted with `k`.
4. `transfer("bob", "1.500")` built the operations, validated them against
   the phone's exact rules, and sent an encrypted `request`.
5. The phone showed a plain-English summary, required PIN/biometrics, signed
   locally, broadcast to the Steem network and returned `{ ok, txId }`.

Your site never touches a private key. Nothing about the key can leak,
because it never exists anywhere but the phone.

## Refreshing an expired QR

QR codes live 5 minutes (`ttlMs`, min 30 s). After that the phone refuses
them:

```ts
if (Date.now() >= auth.expiresAt) {
  auth.dispose();
  // build a fresh createQrSession() and render auth.svg again
}
```

## Minimal React version

```tsx
import { useSteemAuth } from "@steempro/steemauth-qr/react";

const auth = useSteemAuth({ appName: "My dApp" });

if (auth.error)   return <p>{auth.error}</p>;
if (auth.ready)   return <p>Approve on your phone…</p>;
if (!auth.qr)     return <Spinner/>;              // auth.loading is true
return <div dangerouslySetInnerHTML={{ __html: auth.qr.svg }}/>;
// then anywhere:  await auth.transfer("bob", "1.500")
```

No `useEffect`, no refs, no disposal — see [React](react.md).

## Next

- [Requesting operations](operations.md) — every builder, every op type
- [Authentication](authentication.md) — passwordless login with signatures
- [Errors](errors.md) — what can go wrong, and the typed codes to branch on
