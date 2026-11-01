# Authentication — sign in without a password

Prove a user controls their Steem key by having the **phone sign a
challenge**. Nothing is broadcast, the key never leaves the device, and your
backend verifies one signature. This is the Keychain `requestSignBuffer`
model, structured for sessions.

## `session.authenticate()` — the login challenge

```ts
const auth = await session.authenticate();     // zero-config, replay-safe

if (auth.success) {
  // Send these to YOUR backend:
  //   auth.message, auth.signature, auth.nonce,
  //   auth.account, auth.expiresAt, auth.issuedAt
} else {
  console.error(auth.error);
}
```

Everything is optional — omitted fields are filled in automatically:

| Option | Default | Purpose |
|---|---|---|
| `nonce` | 32 hex chars (WebCrypto) | echo it back, check freshness → **replay protection** |
| `expiresAt` | now + 5 min | reject the proof after this ms epoch — **exclusive to this call** |
| `expiresInMs` | `300000` | convenience for `expiresAt` |
| `statement` | `"Sign in to <app>"` | human-readable reason shown on the phone |
| `keyType` | `"Posting"` | `Active` for privileged proofs |

### Exclusive expiry — authentication vs everything else

The challenge's expiry is **yours to choose and belongs only to this call**:

- `expiresAt` / `expiresInMs` set the authorization window independently of
  the QR: `session.authenticate({ expiresInMs: 60_000 })` is a 1-minute
  challenge, `{ expiresInMs: 15 * 60_000 }` a 15-minute one. The value lands
  verbatim on the wire as the request's void-time and as the challenge's
  `Expires At:` line, so the phone stops accepting approval after it and your
  backend rejects the proof after it.
- The window **may outlive the QR** (which always expires at its own
  `ttlMs`, default 5 minutes): the proof is off-chain, so a 30-day
  "authorization" issued while the QR was live stays valid for 30 days —
  the QR only gates *issuing* the request.
- **Nothing leaks in either direction.** Every other operation
  (`requestBroadcast`, actions, `signBuffer`, …) keeps the QR's own expiry
  (`payload.exp` — default 5 minutes) regardless of any `authenticate`
  options; and no other operation inherits the challenge's window. There is
  nothing to "unset" — the two clocks are separate by construction.
- Guard rails: a non-finite (`NaN`) or past expiry fails fast client-side
  with a typed `invalid-request` error instead of ever reaching the phone as
  `Expires At: Invalid Date`.

The signed `message` is a structured, SIWE-inspired challenge the phone
shows **verbatim**:

```
My dApp wants you to sign in with your Steem account:
alice

Sign in to My dApp

Origin: https://my-dapp.com
Session: 3f2504e0-4f89-…
Nonce: a1b2… (32 hex)
Issued At: 2026-10-24T12:00:00.000Z
Expires At: 2026-10-24T12:05:00.000Z
```

Guard rails: a nonce with line breaks is refused (challenge-injection
guard), and an expiry in the past fails fast — both typed `invalid-request`
errors. The phone also **remembers your app** as a revocable session (see
[revocation](revocation.md)).

## Verifying on your backend

```ts
// Pseudocode — use any secp256k1 library
function verifyLogin({ message, signature, nonce, account, expiresAt }, expectedOrigin) {
  // 1. Structure: message must contain YOUR origin, a fresh nonce you issued
  //    (or one you accept), and `Expires At` in the future.
  // 2. Fetch the account's POSTING public key from the chain
  //    (condenser_api.get_accounts → posting.key_auths).
  // 3. Verify the compact Steem signature (hex, 65 bytes, header = recovery+31)
  //    over sha256(message) against that key.
  // 4. Reject when: nonce already used | Date.now() > expiresAt |
  //    account != expected | any check above failed.
  // 5. Issue your own session token.
}
```

Notes:

- verify against the **exact** `auth.message` string — that's what was signed;
- keep a used-nonce store (Redis/set) for the challenge TTL;
- fetching the key per login is one RPC call — cache it briefly.

## `session.signBuffer(data, keyType?)` — arbitrary proofs

The raw primitive: sign any text, get the signature back in
`result.data.signature`. Nothing is broadcast.

```ts
const result = await session.signBuffer("confirm withdrawal #42", "Active");
const signature = result.data?.signature as string;
```

Use it for privileged proofs (Active-key challenges, action confirmations).
`data` is shown on the phone exactly as sent — never put anything in it the
user shouldn't read.

A sign request can never also carry operations — the package refuses the
combination client-side, the phone refuses it server-side.

## Next

- [Revocation](revocation.md) — the user pulls access later
- [React](react.md) — `auth.authenticate()` from a hook
