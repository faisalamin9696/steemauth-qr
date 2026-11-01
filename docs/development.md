# Development

Source: [github.com/faisalamin9696/steemauth-qr](https://github.com/faisalamin9696/steemauth-qr)
(issues welcome). The suites cross-check against sibling checkouts:

```bash
git clone https://github.com/faisalamin9696/steemauth-qr.git
# The relay-plane suite needs the relay as a sibling:
#   ../steemauth-relay      — booted in-process by verify-relay-plane (real sockets)
```

**Where the mobile app is found** — the suites cross-check the app's real
sources through **one module, `scripts/mobile.ts`**, which resolves the
checkout in this order:

1. `STEEMAUTHENTICATOR_DIR` env var (explicit override — use this in CI)
2. `E:\sa` — the app's current local home
3. `../SteemAuthenticator` — the classic sibling layout

First hit containing `src/lib/protocol.ts` wins; a miss fails with the
exact paths tried. The app modules are loaded dynamically, so API drift
surfaces at **run time** (`npm test`) — the app repo runs its own
`tsc --noEmit` for type errors, and this suite proves behavior against
whichever checkout is live.

## Scripts

```bash
npm install
npm run typecheck     # tsc --noEmit (strict)
npm test              # five suites (below)
npm run build         # tsup → dist/ (ESM + CJS + d.ts + d.cts)
npm run dev           # tsup --watch
npm publish           # prepublishOnly: typecheck + test + build
```

## The suites (why "compatible" is a fact, not a claim)

| Suite | Proves |
|---|---|
| `verify-protocol` | loads the app's protocol/decoder/serializer **from the live checkout** (scripts/mobile.ts) and asserts: byte-equal QR parsing + normalization, identical rejection rules and error wording, crypto interop **both directions** (crypto-es ⇄ the app's crypto-js) incl. encrypt-then-MAC parity + tamper/injection drops, sign/revoke/`ready` parity, v1/v2-QR refusal by version, auto-captured `src` |
| `verify-operations` | **all 48 operations**: one valid instance each, accepted by both validators with identical authority AND binary-encoded by the app's serializer; a newly whitelisted op without a fixture fails the build |
| `verify-e2e` | **offline**: an injected in-memory relay (same per-room seq/replay/no-echo contract) with a scripted phone using the app’s real crypto: ready → request → approve/reject/cancel → revoke → resume → typed errors → controller state machine |
| `verify-relay-plane` | **live, local, no credentials**: boots a REAL relay (in-process) and drives REAL sockets — full session loop with the real mobile crypto, resume + re-issue, bad-token bans, phone-token rotation, forged-envelope drops, room isolation, revocation |

CI needs the sibling checkouts (and secrets only for the live suite) so
protocol drift fails the build.

## Layout

```
src/
  index.ts        public exports (single entry)
  session.ts      SteemAuthSession — lifecycle, transport, requests
  actions.ts      the shared account-defaulted action registry (one source
                  of truth behind session.*, controller.* and the hook)
  controller.ts   SteemAuthController — reactive state machine
  react.ts        useSteemAuth() — React binding (subpath ./react)
  errors.ts       SteemAuthError + codes
  qr-session.ts   createQrSession — all-in-one: session + rendered QR
  qr.ts           QR rendering (svg / data URL / canvas)
  relay-plane.ts  the only transport: relay rooms with replay (injectable factory)
  protocol.ts     protocol v3 primitives (QR payload, AES+HMAC, ids) — mirrors the app
  operations.ts   operation whitelist + validation — mirrors the app
  requests.ts     Keychain-style request builders
  types/
    wire.ts       QR payload + realtime message shapes (app-compatible)
    api.ts        Keychain-style request/result + options types
    index.ts      barrel (everything imports ./types)
scripts/
  verify-*.ts     the suites above
```

## Conventions

- **Errors**: raise `SteemAuthError(code, message)` — messages are asserted
  by tests, codes are the API.
- **Actions**: add new account-defaulted actions to `src/actions.ts` only;
  the session/controller/hook expose them automatically as thin wrappers.
- **Wire changes**: update the app repo first (it owns `protocol.ts`), then
  mirror here, then extend both suites in the same change.
- **Docs**: `docs/*.md` are the guides; the root README is the landing page.
  Update both when behavior changes.
