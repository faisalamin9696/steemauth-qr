# @steempro/steemauth-qr

Let people approve Steem actions (vote, transfer, post, …) and log in with
their phone. The request appears on the phone, the user taps approve, and
your site gets the result. **A private key never reaches your server.**

[![GitHub](https://img.shields.io/badge/github-faisalamin9696%2Fsteemauth--qr-181717?logo=github)](https://github.com/faisalamin9696/steemauth-qr)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

```bash
npm install @steempro/steemauth-qr
```

Works out of the box — nothing to configure, no keys to add.

## 1. Show a QR, make a transaction

Put an empty element on your page:

```html
<div id="qr"></div>
```

Then:

```ts
import { steemAuth, requestTransfer } from "@steempro/steemauth-qr";

const r = await steemAuth({
  appName: "My dApp",
  qr: "#qr",                                // where the QR is drawn
  request: requestTransfer("bob", "1.500"), // what the phone will approve
});

if (r.success) console.log("Transaction id:", r.txId);
else console.log("Not approved:", r.error);
```

What happens:

1. A QR code is drawn in `#qr`.
2. The user opens **SteemAuthenticator**, scans it, reads
   *"Transfer 1.500 STEEM to bob"*, and taps approve.
3. Your code continues with the transaction id.

If the user declines, you get `success: false` and the reason in `error`.
When the call ends, everything is cleaned up automatically.

## 2. Log the user in (no password)

```ts
import { steemAuth } from "@steempro/steemauth-qr";

const { account, message, signature, nonce } = await steemAuth({
  appName: "My dApp",
  qr: "#qr",
  login: true,
});
```

The phone signs a message and sends it back. Send `message` + `signature` +
`nonce` to your server and check the signature against the account's public
key — that proves the user owns the account. No password, no key on your
side.

## 3. Just get the account (no approval needed)

```ts
const { account } = await steemAuth({ appName: "My dApp", qr: "#qr" });
// resolves as soon as the phone scans
```

## React

```tsx
import { useSteemAuth } from "@steempro/steemauth-qr/react";

const auth = useSteemAuth({ appName: "My dApp" });

{auth.qr && <div dangerouslySetInnerHTML={{ __html: auth.qr.svg }} />}

await auth.vote("bob", "my-post", 10000);   // draws the QR, waits for approval
await auth.transfer("bob", "1.500");
auth.refresh();                              // new QR after the old one expires
```

Every state you need is on `auth`: `auth.ready`, `auth.requesting`,
`auth.error`, `auth.status`.

## More operations

The same call takes any request builder:

```ts
requestVote(u, author, permlink, weight)   requestPost({ username, body, permlink, … })
requestCustomJson(u, id, json)             requestPowerUp(u, amount)
requestDelegation(u, delegatee, vesting)   requestSignBuffer(u, data)
// …all 48 Steem operations — see docs/api.md
```

## On phones, open the app directly

Add `handoff: true` to any call and, on a phone, the SteemAuthenticator app
opens itself instead of showing a QR to scan:

```ts
steemAuth({ appName: "My dApp", qr: "#qr", handoff: true, request: … });
```

## If something goes wrong

- The user declined → not an error: `success: false`, reason in `error`.
- Anything else throws an error with a machine-readable `code`
  (`timeout`, `revoked`, `session-expired`, …):

```ts
import { isSteemAuthError } from "@steempro/steemauth-qr";

try {
  await steemAuth({ appName: "My dApp", qr: "#qr", request: … });
} catch (e) {
  if (isSteemAuthError(e) && e.code === "timeout") /* show "no answer" */;
}
```

Full list: [docs/api.md — Errors](docs/api.md#errors).

## Optional: your own message server

The default one works for everyone. To run your own:

```bash
npm install -g steemauth-relay
STORE=sqlite RELAY_DB=./relay.db steemauth-relay
```
```ts
steemAuth({ appName: "My dApp", session: { relayUrl: "wss://relay.yourapp.com" } });
```

## Need more control?

**Full API website** — every class, method, function and type, listed and
documented (like the dsteem docs):
**[faisalamin9696.github.io/steemauth-qr](https://faisalamin9696.github.io/steemauth-qr/)**

`createQrSession()` (raw session + QR), `SteemAuthController` (observable
state), statuses, resume after refresh, rendering options — everything is
in [docs/api.md](docs/api.md) (quick reference) or on the API site (full
detail).

## Development

```bash
git clone https://github.com/faisalamin9696/steemauth-qr && cd steemauth-qr
npm test        # five test suites, no credentials needed
```

## License

MIT
