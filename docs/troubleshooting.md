# Troubleshooting

Symptom-first. Every error string the package or the phone can produce, and
what to do about it.

## Nothing happens after showing the QR

| Check | Fix |
|---|---|
| Did you `await createQrSession()` / `await connect()` **before** showing the QR? | the phone's single `ready` races anything sent first — recreate and await |
| Status stuck at `waiting` | that's normal until the phone scans; if a scan *doesn't* answer, check the relay URL and ad-blockers |
| Status `failed` | relay unreachable — `connect()` threw; verify `relayUrl`, network, corporate proxy |
| Works in dev, dies in prod | mixed content / CSP — allow `wss://<relay-host>` |

## Connection errors

| Error / code | Fix |
|---|---|
| `Timed out joining the relay room — check the relayUrl and network` (`plane-timeout`) | bad URL, offline, relay down. `connect()` is retryable |
| `Relay connection failed — check the relayUrl and network` (`plane-failed`) | subscribe failed — is your relay running? self-hosted: check `STORE`/DB |
| `Relay room expired - generate a fresh QR code` (`plane-timeout`) | the phone noticed the room died — rebuild the session |

## Requests

| Outcome / error | Fix |
|---|---|
| `Session not connected — call connect() first` (`not-connected`) | await `connect()` before requesting |
| `Session expired — generate a fresh QR code` (`session-expired`) | TTL passed — new session, fresh QR |
| `No authenticator connected yet…` (`no-account`) | act after `waitForAccount()` resolves (status `ready`) |
| `Request not sent — Unsupported operation: x` (`invalid-request`) | not in the app's 48-op whitelist ([operations](operations.md)) |
| `Request not sent — Operations do not involve @x` | the phone only signs ops referencing its selected account |
| `Request not sent — Too many operations in one request (max 20)` | split the batch, or use `batch()` |
| `Request not sent — a sign request cannot also carry operations` | sign xor ops, by design |
| `Invalid amount "1.9999": at most 3 decimal places` | money is never silently rounded — send 3 decimals |
| `Timed out waiting for the mobile app…` (`timeout`) | nobody approved within `requestTimeoutMs` (default: QR TTL) — show the QR again |
| Result `success: false` + "User rejected…" | the user said no — **the app closed the session**; show a fresh QR |
| Result `success: false` + "Access was revoked…" | the user revoked the app ([revocation](revocation.md)) — rebuild the session |
| `claim_reward_balance` fails on-chain | amounts must equal current unclaimed rewards **exactly** — fetch first |

## Authentication

| Symptom | Fix |
|---|---|
| `nonce must be printable ASCII without line breaks` | server-generated nonces should be hex/base64url — no newlines |
| `expiresAt must be in the future` | clock skew or bad math — use `expiresInMs` |
| Backend verification fails | verify the **exact** `auth.message` string; fetch the posting key; check the compact signature format (65 bytes hex) |

## QR codes

- Expired codes are refused with *"refresh it"* — rebuild the session.
- ~400 bytes payload; render ≥ 240 px, keep margin 4, don't scale the SVG
  below its module grid (the #1 scan failure).
- Scanning fails in bright light / low contrast? Force `dark`/`light` to
  high-contrast colors; use `errorCorrectionLevel: "H"` under a logo.

## Runtime

| Error | Fix |
|---|---|
| `No secure random source (WebCrypto) available…` | browser or Node ≥ 22 |
| `window is not defined` during SSR | create sessions client-side (effects/`onMount`) — the hook is SSR-safe, raw construction is not |
| React hook re-creates the session every render | you're passing changing option *values* — memoize them |

## Self-hosted pieces

| Piece | Check |
|---|---|
| Relay | `curl http://localhost:8787/healthz` → `ok`; rooms in sqlite survive restarts (`STORE=sqlite`), memory rooms do not |
| CI | the suites need sibling checkouts `../SteemAuthenticator` and `../steemauth-relay` ([development](development.md)) |

## Still stuck?

Open an issue on [github.com/faisalamin9696/steemauth-qr](https://github.com/faisalamin9696/steemauth-qr/issues)
with: package version, runtime (browser/Node/React version), the exact
error/code, and (if it's about the wire) which side rejected what. The
protocol suites make "works here" claims checkable.
