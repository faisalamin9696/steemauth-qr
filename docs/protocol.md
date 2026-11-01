# Protocol (wire format)

For the curious — and for anyone building their own client. The source of
truth is the mobile app's `src/lib/protocol.ts`; this package mirrors it
file-for-file and the test suites cross-check both directions on every run.

> **v3 — the relay plane.** v2 routed every message through a Supabase
> project shipped inside the QR (`sup`). v3 moves the whole plane into the
> relay itself: the QR carries a **relay URL** (`rt`), an unguessable
> **room** (`rm`) and the **phone's room token** (`tk`); the relay keeps
> per-room sequenced logs with replay. No database credential ever reaches a
> client, every envelope is encrypt-then-MAC'd, and joins are token-
> authenticated (the relay stores only sha256 hashes). v1/v2 payloads are
> refused by the version check on both sides.

## The QR (protocol v3)

```jsonc
{
  "v": 3,                          // protocol version (v1/v2 QRs refused)
  "t": "steem.session",            // payload type
  "sid": "<uuid>",                 // session id (inside the ciphertext)
  "app": "My dApp",                // shown on the phone (≤ 80 chars)
  "url": "https://your.app",       // declared origin (informational)
  "src": "https://your.app",       // VERIFIED origin — auto, non-overridable
  "chain": "steem",                // only "steem"
  "rt": "wss://relay.steempro.com", // the relay plane — the only endpoint
  "rm": "rm_<base64url>",          // unguessable room (~176 bits)
  "tk": "tok_<base64url>",         // the PHONE's token (app keeps its own)
  "k": "<base64, 32 bytes>",       // AES key — both sides, nowhere else
  "ts": 1712345678900,             // issued-at (ms)
  "exp": 1712345738900             // expiry (ms) — the phone refuses past this
}
```

Validation (identical on both sides): version + type exact (`v === 3`);
`sid` ≥ 8 chars; `k` ≥ 16 chars; `exp > now`; `ts` ≤ 60 s in the future;
`chain` (if present) `steem`; `src` (if present) `http(s)://…`;
**`rt`** `ws(s)://…`; **`rm`** `rm_[A-Za-z0-9_-]{16,64}`;
**`tk`** `tok_[A-Za-z0-9_-]{32,128}`.

The app's own token is **never** in the QR — only its sha256 hash goes to
the relay (at room registration), so a QR leak never exposes the app side.

## Transport: the relay room

All traffic rides one WebSocket connection per side to `rt`, addressed by
room. The relay (steemauth-relay v3, protocol v3) keeps each room as a
sequenced log:

```
create → ok { cursor }          app side: register room with both TOKEN HASHES
join   → ok { cursor }          phone side (or app reconnect): token check
pull   → rows [[seq, payload]…] replay seq > cursor (the refresh healer)
msg    → ack { seq } + broadcast to OTHER members (no sender echo)
rotate → ok { tok }             app token only: new phone token (re-pair)
close  → (members closed)       app token only: room + rows deleted
ping   → pong
err    → { code }               bad_shape · bad_token · room_expired ·
                                room_exists · too_many_rooms · not_member ·
                                not_app · rate_limited · room_log_full ·
                                room_full
```

- **Seq is per-room**, starts at 1; receivers deliver `seq > cursor` only
  (replay ∩ live overlap delivers once).
- Rooms expire on sliding idle (default 15 min) + hard cap (60 min); the
  sweeper deletes rows with the room. `close` deletes immediately.
- Limits: 64 KB envelope, 70 KB frame, 4 members/room, 20 msg/s per
  connection, per-IP create/join caps, auth-failure IP bans.

## Encryption (encrypt-then-MAC, unchanged cipher)

- `c` = `CryptoJS.AES.encrypt(JSON, k)` — passphrase AES-256-CBC in the
  OpenSSL `Salted__` envelope (crypto-es on the web, crypto-js on the app;
  interchangeable — proven both directions by `scripts/verify-protocol.ts`).
- `m` = `HMAC-SHA256(c)` with `SHA256("steemauth-v3-mac:" + k)` — a domain-
  separated MAC key. Envelopes are `{ c, m }`.
- Receivers verify `m` **before** decrypting and drop anything that fails
  (constant-time-ish tag compare). The relay can store and forward blobs it
  cannot read, and cannot inject one that verifies — tampering, bit-flips,
  cross-session replays and forged rows all die at the tag check.

## Messages

Inside `payload.c`, every message carries `sid`:

| Direction | Type | Fields |
|---|---|---|
| phone → app | `ready` | `account`, `authority`, `device?` — the handshake, as a row |
| app → phone | `request` | `id`, `ops` (≤ 20), `sign?`, `notify?`, `action?`, `meta?`, `exp?` |
| phone → app | `result` | `id`, `ok`, `txId?`, `error?`, `account?`, `signature?`, `notify?` |
| either | `cancel` | `id`, `reason?` |
| phone → app | `revoke` | `reason?` — the user removed this app; session over |
| either | `ping` / `pong` | keepalive |

### `request` invariants

- `ops` **xor** `sign`: a signing request carries no operations;
- `ops` must be a non-empty array of `[name, params]` pairs, ≤ 20, every
  type in the serializer whitelist (48), and — when the phone has an
  account — at least one operation must reference it;
- key authority is computed per batch (`custom_json` with non-empty
  `required_auths` requires active);
- `exp` (if set) voids the request once passed. Ordinary requests always
  carry the QR's own expiry; only `authenticate()` takes a client-settable
  window (see [authentication](authentication.md)).

### `sign`

```jsonc
{ "data": "<exact UTF-8 text — shown verbatim>", "keyType": "Posting" }
```

The phone signs `sha256(data)` with the account's key and returns the
compact signature (hex, 65 bytes, header = recovery + 31). Nothing touches
the chain. `action: "authenticate"` additionally records the app as a
revocable session.

## Signing (phone side, for context)

Transactions are built locally: ref block from
`dynamic_global_properties`, 30 s expiration, chain id `00…00` (32 zero
bytes). Signatures are low-s, canonical, deterministic-retry —
byte-compatible with `@steempro/dsteem`. Keys never leave the device.

## Compatibility policy

Protocol v3 is additive-only from here: new optional fields never break
older v3 peers. Version bumps (`v`) are the hard line — anything a released
build would misinterpret must bump `v` so both sides refuse cleanly (v1 and
v2 are refused today). Wire changes require the `verify-protocol` suites on
both repos updated together.
