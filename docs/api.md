# API reference

The complete API in one file. Types ship for ESM and CJS.
**Prefer browsing?** The generated site lists every class, method, function
and type with signatures:
**[faisalamin9696.github.io/steemauth-qr](https://faisalamin9696.github.io/steemauth-qr/)**

```ts
import { steemAuth, requestTransfer, … } from "@steempro/steemauth-qr";   // core
import { useSteemAuth } from "@steempro/steemauth-qr/react";              // React
```

## `steemAuth()` — the one-call entry point

```ts
const r = await steemAuth({
  appName: "My dApp",              // required — shown on the phone
  qr: "#qr",                       // CSS selector | Element → injects the SVG
  onQr: (svg) => …,                // or receive the SVG yourself (React state)
  request: requestTransfer("bob", "1.500"),   // mode 1: approve a transaction
  login: true,                     // mode 2: sign the off-chain challenge
  statement: "Sign in to My dApp", // login-mode challenge text
  handoff: true,                   // open the phone app on touch devices
  origin: "https://your.app",      // defaults to window.location.origin
  ttlMs: 300_000,                  // QR lifetime (default 5 min)
  onSession: (s) => …,             // live session handle (listeners, tests)
  session: { relayUrl, planeFactory, … },   // advanced passthrough
}): Promise<SteemAuthResult>
```

Mode 3: omit `request` and `login` → resolves `{ success, account }` as soon
as the phone scans (account linking).

```ts
interface SteemAuthResult {
  success: boolean; account: string | null;
  txId?: string;                  // request mode
  error?: string;                 // rejection reason when success === false
  message?: string; signature?: string; nonce?: string; expiresAt?: number;  // login mode
}
```

The session is always disposed when the call settles. Phone rejections
**resolve** with `success: false` (a normal outcome); transport failures
**reject** with a typed `SteemAuthError`.

## `createQrSession()` — full control

```ts
createQrSession(options: SteemAuthSessionOptions & { qr?: QrRenderOptions; skipDataUrl?: boolean })
  : Promise<QrSession>

interface QrSession {
  session: SteemAuthSession;      // live handle
  qrString: string;               // encode yourself with any QR library
  svg: string; dataUrl: string;   // ready to inject
  expiresAt: number; dispose(): void;
}
```

`SteemAuthSessionOptions`: `appName` (required) · `origin?` · `relayUrl?` ·
`ttlMs?` · `requestTimeoutMs?` · `subscribeTimeoutMs?` · `persistSession?` ·
`storage?` · `planeFactory?` (test seam).

## `SteemAuthSession`

```ts
// lifecycle
connect(): Promise<void>          // room live (retryable, typed) — createQrSession does this
dispose(): void
get connectionStatus / account / isRevoked / revocationReason
get expiresAt / pendingCount / payload / restoredRequest

// waiting & requests
waitForAccount(): Promise<{ account; authority; device? }>
request(req: KeychainRequest): Promise<KeychainResult>
cancel(id?: string, reason?: string): void
ping(): void
onStatus(cb): () => void                        // fires immediately

// account-defaulted actions (auto-fill the connected account)
vote(author, permlink, weight%)      transfer(to, amount, memo?)
post(params)                         customJson(id, json, keyType?)
broadcast(operations, keyType?)      batch(requests, keyType?)
powerUp(amount, to?)                 powerDown(vestingShares)
delegate(delegatee, vestingShares)   claimRewards(params)
witnessVote(witness, approve?)       setProxy(proxy)
action(name, …args)                  // generic form of any above
signBuffer(data, keyType?)           // off-chain signature

// login challenge — exclusive expiry (expiresAt/expiresInMs, default 5 min);
// every other request rides the QR's own window
authenticate(options?: AuthenticateOptions): Promise<AuthenticateResult>

// refresh survival (opt-in persistSession)
static resume(options?): Promise<SteemAuthSession | null>
```

`AuthenticateOptions`: `nonce?` · `expiresAt?` · `expiresInMs?` ·
`statement?` · `keyType?` → `AuthenticateResult`: `success` · `account` ·
`nonce` · `issuedAt` · `expiresAt` · `message` · `signature?` · `error?`.

## Request builders (Keychain-style)

```ts
requestVote(u, author, permlink, weight)     requestTransfer(u, to, amount, memo?, keyType?)
requestPost({ username, title?, body, permlink, parentAuthor?, parentPermlink?, jsonMetadata? })
requestCustomJson(u, id, json, keyType?)     requestBroadcast(u, operations, keyType?)
requestPowerUp(u, amount, to?)               requestPowerDown(u, vestingShares)
requestDelegation(u, delegatee, vesting)     requestClaimRewards({ username, rewardSteem?, rewardSbd?, rewardVests? })
requestWitnessVote(u, witness, approve?)     requestProxy(u, proxy)
requestBatch(u, requests, keyType?)          requestSignBuffer(u, data, keyType?)

// typed registry behind the actions
ACTIONS · buildAction(name, account, args) · type ActionName / ActionArgs<N>
```

All 48 chain operations validate identically on both sides — see
`validateOperations`, `SUPPORTED_OPERATIONS`, `MAX_OPERATIONS_PER_REQUEST`
(20) if you build batches by hand.

## Reactive state (controller + hook)

```ts
new SteemAuthController(options)     // session options & { qr?, skipDataUrl? }
getState(): SteemAuthState           // immutable snapshot
subscribe(cb): () => void            // fires immediately
start() · refresh() · dispose()      // start() may reject (also in state)
request/action/actions … never throw → return null
get session: SteemAuthSession | null

useSteemAuth(options) = SteemAuthState + the same actions + start/refresh/dispose

interface SteemAuthState {
  status: "connecting" | "waiting" | "ready" | "failed" | "disconnected" | "revoked";
  account; error; errorCode; qr; expiresAt; expired; requesting; ready; loading; disposed;
}
```

## Handoff (same-device phone)

```ts
handoffToSteemAuthenticator(qrString): "bridge" | "scheme" | "none"
isTouchBrowser(): boolean · isInSteemAuthenticator(): boolean
```

Inside the authenticator's in-app browser the payload goes through the
WebView bridge; in external mobile browsers a `steemauth://` intent carries
it; on desktop it returns `"none"` and you show the QR.

## Revocation watch (registry-backed)

```ts
watchRevocation(options): RevocationWatch
RevocationWatchOptions { sid: string; relayUrl?: string; onRevoked(reason: string): void }
RevocationWatch { close(): void; readonly closed: Promise<void> }
```

Logs the user out the moment they revoke your app from the
SteemAuthenticator **Sessions tab** — even after the relay room is long
gone. Pass the `sid` the account **logged in with** (the registry rows are
keyed by it; the session's own sid changes on `refresh()`).

How it works: the relay optionally holds the session registry (Supabase
lives *only* inside the relay — no credential, no row, nothing on the
client). Your watch sends `{ t:"watch", sid }`; when the phone writes
`revoked_at`, the relay pushes `{ t:"revoked", sid, reason }` and
`onRevoked` fires **once** with the phone's reason.

```ts
const watch = watchRevocation({
  sid: account.sid!,                        // login sid, stored at sign-in
  onRevoked: (reason) => signOut(reason),   // your action — toast, redirect …
});
watch.close();                              // on logout / unmount
```

Notes:

- **Fail-open** — a relay without a registry (or an older relay) refuses
  the frame and the watch closes silently; revokes inside a live room are
  still delivered over the room path.
- **Reconnects** — dropped sockets are retried with capped backoff
  (1 s → 30 s) and the relay re-checks the registry on every watch, so a
  revoke that happened while offline still fires on reconnect.
- `closed` resolves when the watch is finished (revoked, refused, or
  `close()`); `sid` must be a UUID (throws `invalid-request` otherwise).
- `relayUrl` defaults to `DEFAULT_RELAY_URL`; pass the URL your sessions
  actually use when self-hosting the relay.

## QR rendering

```ts
toQrSvg(payload, options?) · toQrDataUrl(payload, options?) · toQrCanvas(canvas, payload, options?)
QrRenderOptions { size?; margin?; errorCorrectionLevel?: "L"|"M"|"Q"|"H"; dark?; light? }
```

## Errors <a name="errors"></a>

```ts
class SteemAuthError extends Error { readonly code: SteemAuthErrorCode }
isSteemAuthError(e): e is SteemAuthError
```

| Code | Meaning |
|---|---|
| `timeout` | no answer from the phone within the request timeout |
| `revoked` | the user removed this app in the authenticator |
| `session-expired` | the QR TTL passed — refresh for a new code |
| `invalid-request` | refused client-side **before sending** (whitelist, ≤ 20 ops, sign xor ops, …) |
| `not-connected` | a request before `connect()` finished |
| `no-account` | an action before the phone scanned |
| `disposed` | the session was disposed |
| `plane-timeout` | relay-room join took too long (retryable) |
| `plane-failed` | relay connection failed (join/send) |

Phone rejections are **not** errors: they resolve `{ success: false, error }`.

## Protocol (v3) <a name="protocol"></a>

Wire spec source of truth: the mobile app's `src/lib/protocol.ts`
([PROTOCOL.md](https://github.com/faisalamin9696/SteemAuthenticator/blob/main/PROTOCOL.md)).
This package mirrors it and the suites cross-check both every run.

**QR payload** (JSON in the QR):

```jsonc
{ "v": 3, "t": "steem.session", "sid": "<uuid>", "app": "My dApp",
  "url": "https://…", "src": "https://…",        // src = verified origin, auto
  "chain": "steem",
  "rt": "wss://relay.steempro.com",              // the relay plane
  "rm": "rm_<base64url>",                        // room (~176 bits)
  "tk": "tok_<base64url>",                       // phone token (app keeps its own)
  "k": "<base64, 32 bytes>",                     // AES+HMAC key, both sides
  "ts": 1712345678900, "exp": 1712345738900, "account"?: "alice" }
```

**Transport**: one WebSocket room per side. `create` registers the room with
**sha256 hashes** of both tokens (the relay never sees the secrets); `join`
authenticates; `msg → ack` appends to a per-room **sequenced log**; `pull`
replays `seq > cursor` — the refresh/background healer. The relay sweeps
idle rooms (15 min) and enforces per-IP bans and rate limits.

**Envelope**: `{ c, m }` — `c` = passphrase AES-256-CBC (crypto-es ⇄
crypto-js, byte-interchangeable), `m` = HMAC-SHA256 with a key derived from
`k`. Receivers verify `m` **before** decrypting and drop failures — the
relay can neither read messages nor inject one that verifies.

**Messages** (inside `c`, each carries `sid`): `ready` (phone → app
handshake) · `request` (id, ops ≤ 20, sign?, meta?, exp?) · `result` (id,
ok, txId?, error?, signature?) · `cancel` · `revoke` · `ping`/`pong`.

**Revocation watch** (Supabase-backed): after the handshake, the package
sends `{ t:"watch", sid }` to the relay — and `watchRevocation()` (above)
opens the same watch for a *login* sid outside any session. The relay
polls Supabase for `revoked_at` changes (batched, only while watchers
exist, plus an immediate catch-up on every watch) and pushes
`{ t:"revoked", sid, reason }` to all watching sockets. Credentials never
leave the relay process. One-shot: once revoked, the sid is removed from
watchers. The watch outlives the room — it needs no room membership.

v1/v2 payloads are refused by the version check on both sides.

## Security, in five bullets

- CSPRNG only (`sid`, `k`, ids, nonces) — no `Math.random`
- `src` in every QR is the unspoofable `window.location.origin`
- encrypt-then-MAC envelopes; possession of the QR (rm + tk + k) is the cap
- no credentials anywhere: relay URL is a public constant, tokens are
  hashed server-side; a test fails the build if a JWT ever lands in the repo
- requests validate against the phone's exact rules *before* sending

**Supabase revocation watch security**: credentials stay in the relay
process only (no endpoint exposes them, no frame carries them). Sid format
is validated (UUID regex) before any query. Poll runs only while watchers
exist (zero cost when idle). One-shot: revoked sids are removed from
watchers immediately. Rate limiting: the existing per-connection token
bucket applies to `watch` frames.

## Development <a name="development"></a>

```bash
npm test      # five suites: protocol · operations · e2e · relay-plane · handoff
```

Offline/loopback only — no credentials. The suites load the mobile app's
real sources (sibling checkout or `STEEMAUTHENTICATOR_DIR`), boot a real
relay in-process, and scan for credentials. Publishing runs the gate via
`prepublishOnly`.
