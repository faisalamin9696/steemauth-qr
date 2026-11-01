# @steempro/steemauth-qr

[![GitHub](https://img.shields.io/badge/github-faisalamin9696%2Fsteemauth--qr-181717?logo=github)](https://github.com/faisalamin9696/steemauth-qr)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Request **any Steem blockchain action** — vote, transfer, post, custom JSON,
power up/down, delegate, escrow, proposals, witnesses, all 48 operation
types — plus passwordless **login**, from any web app.
The user approves on their phone with the
**SteemAuthenticator** app; the transaction is signed and broadcast
**on-device**. Your site never touches a private key.

```
┌──────────────────┐   QR (session)     ┌────────────────────┐
│  Your web app    │ ─────────────────▶ │ SteemAuthenticator │
│  + this package  │                    │  (mobile app)      │
│                  │ ◀──────────────── │  scans → verifies  │
│  relay plane     │  sealed msgs       │  → shows plain text│
│ (rooms + replay) │                    │  → PIN → signs     │
└──────────────────┘                    └────────────────────┘
```

Transport is **protocol v3**: one token-authenticated room per session on a
public relay — sequenced logs with replay, encrypt-then-MAC payloads, and
zero credentials in your bundle.

## Install

```bash
npm install @steempro/steemauth-qr
```

Zero configuration: the relay endpoint is a public constant (nothing to configure), the QR renders
built-in, and **no credentials ever appear in your bundle**.

## 20-line quick start

```ts
import { createQrSession } from "@steempro/steemauth-qr";

const auth = await createQrSession({ appName: "My dApp" });
document.querySelector("#qr")!.innerHTML = auth.svg;         // show the QR

const { account } = await auth.session.waitForAccount();      // phone scanned

const result = await auth.session.transfer("bob", "1.500");  // auto-account
result.success
  ? console.log("tx:", result.data?.txId)
  : console.log("rejected:", result.error);

auth.dispose();
```

React is even shorter — [`useSteemAuth`](docs/react.md) does all of the
above as reactive state:

```tsx
const auth = useSteemAuth({ appName: "My dApp" });
// auth.loading · auth.ready · auth.error · auth.qr.svg · await auth.vote("bob", "p", 100)
```

## Guides

| Guide | What's inside |
|---|---|
| [Installation & setup](docs/installation.md) | requirements, zero-config, self-hosting, frameworks |
| [Quick start](docs/quick-start.md) | first QR → first transaction, explained end to end |
| [QR codes](docs/qr-codes.md) | rendering (SVG/PNG/canvas), branding, refresh, the verified `src` origin |
| [Sessions](docs/sessions.md) | lifecycle, statuses, events, request semantics |
| [Operations](docs/operations.md) | every builder + all 48 chain operations + validation |
| [Authentication](docs/authentication.md) | sign-in challenges, backend verification |
| [Revocation](docs/revocation.md) | the three-layer revoke detection & recovery |
| [Relay plane](docs/message-plane.md) | protocol v3: token-authenticated rooms with replay + refresh survival |
| [React & reactive state](docs/react.md) | the hook, the controller, performance |
| [Errors](docs/errors.md) | typed errors with machine-readable codes |
| [Security](docs/security.md) | threat model, guarantees, your checklist |
| [Protocol](docs/protocol.md) | the wire format, for the curious |
| [Troubleshooting](docs/troubleshooting.md) | every symptom → fix |
| [Keychain migration](docs/keychain-migration.md) | porting from SteemKeychain |
| [API reference](docs/api-reference.md) | every export, every type |
| [Development](docs/development.md) | repo layout, suites, publishing |

## Highlights

- **Zero-config**: zero endpoints to set up, built-in QR rendering (SVG / PNG /
  canvas), no database, no API keys, nothing embedded in your bundle.
- **All 48 Steem operations**, each one proven end-to-end by the test suite
  (validated *and* binary-encoded by the app's serializer on every run).
- **Keychain-style API** — same builder names and semantics, promise-based;
  [port in three steps](docs/keychain-migration.md).
- **Login without passwords** — `session.authenticate()` signs a
  replay-safe challenge off-chain; your backend verifies one signature.
- **Verified origin** — every QR carries `src`, captured from
  `window.location.origin` and *not overridable* (browsers make location
  unforgeable), so the phone shows users the app's real URL.
- **Refresh-proof approvals** — opt-in `persistSession`: a page reload
  resumes the same room (phone never notices) and re-issues the in-flight
  request with the same id; plus protocol v3's **relay plane**, where every
  room is a sequenced log with replay — backgrounded phones and dropped
  sockets lose nothing.
- **Revocation that actually works** — three independent detection layers,
  no hanging promises, typed `revoked` failures.
- **Typed errors** — `SteemAuthError.code` for branching, byte-stable
  messages for display.
- **Framework-friendly** — core is framework-free; first-class React hook;
  the same reactive controller for everything else.

## Compatibility you can verify

The suites import the **mobile app's actual TypeScript sources** and a
**real relay over real sockets**: byte-equal QR parsing, encrypt-then-MAC
interop in both directions, the full operations matrix, offline and live
end-to-end sessions, a security suite (token auth, IP bans, forged-envelope
drops, room isolation) and credential scans. `npm test` — see
[Development](docs/development.md).

## License

MIT
