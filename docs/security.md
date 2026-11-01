# Security

The design goal in one line: **your site never touches a private key**, and
nothing you can get wrong changes that.

## What the package guarantees

- **CSPRNG only** — `sid`, `k`, request ids and auth nonces come from
  WebCrypto; environments without it throw instead of degrading. No
  `Math.random` anywhere.
- **Verified origin in every QR** — `src` is captured from
  `window.location.origin`, which browsers mark `[Unforgeable]`: page code
  cannot spoof it, and there is no API to set it. The phone shows it as the
  app's URL.
- **Encrypt-then-MAC transport** — every message is passphrase-mode
  AES-256-CBC (OpenSSL `Salted__` envelope) plus an HMAC-SHA256 tag derived
  from the session key. Wrong keys, foreign `sid`s, tampered rows and
  relay-side injection all fail the tag check and are dropped before any
  decryption; a leaked room name or token alone reveals nothing.
- **Short-lived credentials** — the QR (which carries `k`) expires in 5
  minutes (min 30 s) with a 60 s future-clock guard, validated identically
  on both sides.
- **Fail-fast validation** — requests are checked against the phone's exact
  rules *before* being sent: whitelist, ≤ 20 ops, account reference, sign
  xor ops, amount exactness (no silent rounding of money).
- **No credential surface anywhere** — the endpoint is a public wss://
  constant (already in every QR). Room registration sends only sha256
  hashes of the client-generated tokens; the relay stores hashes, never
  tokens, and has no config endpoint to query. A test fails the build if a
  JWT-shaped credential ever appears in `src/`, `dist/` or the README.
- **Token-authenticated rooms** — joins prove possession of the QR's room
  token; only the app's own token (never in the QR) can rotate the phone
  token or close the room; repeated auth failures ban the IP.
- **Durable revocation** — a revoked app dies on the live row, on replay,
  and by the room itself (no room, no path to the phone) with no hanging
  promises ([revocation](revocation.md)).
- **Zero key exposure** — keys exist only in the phone's secure enclave;
  your app receives operation results and transaction ids, nothing else.

## What YOU should do

- 🟢 Serve your app over **HTTPS** (WebCrypto + wss require it).
- 🟢 Treat a live QR like a **one-time password on screen**: never log or
  persist `qrString` / `payload.k`; `dispose()` when the flow ends.
- 🟢 Show your own summary of what is being requested — the phone
  independently decodes every operation, but users trust familiar UI.
- 🟢 Keep the library updated; protocol drift fails the test suite.
- 🟢 Verify authentication proofs server-side: exact message, fresh nonce,
  unexpired, account you expect ([authentication](authentication.md)).
- 🔴 Never accept operations you didn't construct — don't forward raw user
  input as batches.
- 🔴 Never ask for a private key or WIF. This package cannot sign; anything
  requesting one "for the authenticator" is a scam.

## Threat notes (honest scope)

| Threat | Outcome |
|---|---|
| Attacker guesses the room/token | ~176-bit room + ~256-bit token, both required — infeasible; without `k` they see only ciphertext |
| Attacker observes a QR photo | they are the session for ≤ 5 min — same as the user scanning it; the phone still shows every action for approval |
| Malicious site crafts a hostile QR | possible for anyone — which is why the phone decodes and displays every operation in plain English and requires PIN/biometrics |
| Compromised relay | can disrupt (drop/delay) service and observe metadata (rooms, timing, sizes); cannot read, forge (HMAC with `k`) or replay into other rooms |
| Supply chain | deps are minimal (`crypto-es`, `qrcode`); the wire format is verified against the app's own crypto on every test run |

## Reporting

Open an issue on [github.com/faisalamin9696/steemauth-qr](https://github.com/faisalamin9696/steemauth-qr/issues)
— please include the version, runtime, and a reproduction.
