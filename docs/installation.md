# Installation & setup

Everything you need to go from `npm install` to a working integration — and
nothing you *don't* need: no database, no API keys, no accounts.

## Requirements

| | |
|---|---|
| **Package formats** | ESM + CJS, TypeScript types bundled for both |
| **Browsers** | all evergreen (WebCrypto + WebSocket required) |
| **Node.js** | ≥ 22 (SSR/tooling; WebSocket + WebCrypto are global) |
| **React** | ≥ 18, *optional* — only needed for `useSteemAuth` |
| **Phone app** | [SteemAuthenticator](https://github.com/faisalamin9696/steemauth-qr) — the user installs it; you never touch keys |

## Install

```bash
npm install @steempro/steemauth-qr
```

```ts
import { createQrSession, requestVote } from "@steempro/steemauth-qr";   // ESM
const { createQrSession } = require("@steempro/steemauth-qr");           // CJS

// React only (optional peer dependency):
import { useSteemAuth } from "@steempro/steemauth-qr/react";
```

## Zero configuration — the default

```ts
const auth = await createQrSession({ appName: "My dApp" });
```

That's a complete setup — there is no endpoint to configure and no
credential to ship. Every session rides the shared public relay plane
(`DEFAULT_RELAY_URL`, already visible in every QR); the QR itself carries
the room (`rm`) and the phone's token (`tk`), both generated client-side,
and every message is encrypt-then-MAC'd with a per-session key that exists
only inside the QR. A test suite fails the build if a credential ever
sneaks into `src/`, `dist/` or the README.

## Bring your own relay (optional)

For isolation, compliance or branding, self-host
[`steemauth-relay`](https://github.com/faisalamin9696/steemauth-qr) — one
Node process, memory or sqlite store, no other services:

```bash
npm install -g steemauth-relay
STORE=sqlite RELAY_DB=/data/relay.db PORT=8787 steemauth-relay
```

```ts
new SteemAuthSession({ appName: "My dApp", relayUrl: "wss://relay.yourapp.com" });
```

The URL is embedded in the QR's `rt`, so the phone joins exactly your
relay. Self-hosters need nothing else — the relay IS the transport, the
durable log and the revocation channel.

## Session lifecycle & revocation

Sessions live inside their room: requests, the `ready` handshake and
revocation are all sealed rows in the room's log, replayed to anyone who
joins with the right token. When the room expires (or the user revokes the
app), the session's transport is gone entirely — see
[revocation](revocation.md).

## Frameworks

| Setup | Entry point |
|---|---|
| Vanilla / any bundler | `@steempro/steemauth-qr` |
| React (hooks + state) | `@steempro/steemauth-qr/react` |
| Vue / Svelte / solid | `@steempro/steemauth-qr` + [`SteemAuthController`](react.md) |

## Next

- [Quick start](quick-start.md) — your first QR in five minutes
- [QR codes](qr-codes.md) — rendering, branding, refresh
- [Installation done → errors](errors.md) — every error, typed, with codes
