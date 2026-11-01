# API reference

Every public export. Types are bundled for ESM and CJS.

## Entry points

```ts
import { … } from "@steempro/steemauth-qr";        // core (framework-free)
import { useSteemAuth } from "@steempro/steemauth-qr/react";   // React hook
```

## Session

```ts
new SteemAuthSession(options: SteemAuthSessionOptions)

// lifecycle
connect(): Promise<void>                    // plane stream live (retryable, typed)
dispose(): void
get connectionStatus / account / isRevoked / revocationReason
get expiresAt / pendingCount / payload: SessionQrPayload
get restoredRequest: Promise<KeychainResult> | null   // resume()'s re-issued request

// refresh survival (opt-in persistSession)
persistSession?: boolean                    // snapshot → sessionStorage (TTL-bounded)
storage?: SessionStorageLike                // custom backend (defaults SSR-safe)
static resume(options?): Promise<SteemAuthSession | null>   // rebuild after a refresh

// QR
get qrString: string
qrSvg(options?: QrRenderOptions): Promise<string>
qrDataUrl(options?: QrRenderOptions): Promise<string>

// events & handshake
onStatus(cb: (s: ConnectionStatus) => void): () => void     // fires immediately
waitForAccount(): Promise<{ account; authority; device? }>  // rejects after revoke

// requests
request(req: KeychainRequest): Promise<KeychainResult>       // typed errors; expiry = QR window (only authenticate() is custom)
cancel(id?: string, reason?: string): void
ping(): void

// account-defaulted actions (typed; throw typed errors)
vote(author, permlink, weight%)            transfer(to, amount, memo?)
post(params: PostParams)                   customJson(id, json, keyType?)
broadcast(operations, keyType?)            batch(requests: BatchInput[], keyType?)
powerUp(amount, to?)                       powerDown(vestingShares)
delegate(delegatee, vestingShares)         claimRewards(params: ClaimRewardsParams)
witnessVote(witness, approve?)             setProxy(proxy)
action<N>(name, ...args)                   // generic form of any above

// off-chain signing
signBuffer(data, keyType?): Promise<KeychainResult>
authenticate(options?: AuthenticateOptions): Promise<AuthenticateResult>
```

`SteemAuthSessionOptions`: `appName` (required) · `origin?` · `relayUrl?` ·
`ttlMs?` · `requestTimeoutMs?` · `subscribeTimeoutMs?` · `persistSession?` · `storage?` · `planeFactory?`

## All-in-one

```ts
createQrSession(options: CreateQrSessionOptions): Promise<QrSession>
// = SteemAuthSessionOptions & { qr?: QrRenderOptions; skipDataUrl?: boolean }

interface QrSession {
  session: SteemAuthSession;      // live handle
  qrString: string; svg: string; dataUrl: string;
  expiresAt: number; dispose(): void;
}
```

## QR rendering

```ts
toQrSvg(payload, options?): Promise<string>
toQrDataUrl(payload, options?): Promise<string>
toQrCanvas(canvas: HTMLCanvasElement, payload, options?): Promise<void>

interface QrRenderOptions { size?; margin?; errorCorrectionLevel?: "L"|"M"|"Q"|"H"; dark?; light? }
```

## Request builders (Keychain-style)

```ts
requestVote(username, author, permlink, weight): KeychainRequest
requestTransfer(username, to, amount, memo?, keyType?): KeychainRequest
requestPost({ username, title?, body, permlink, parentAuthor?, parentPermlink?, jsonMetadata? }): KeychainRequest
requestCustomJson(username, id, json, keyType?): KeychainRequest
requestBroadcast(username, operations, keyType?): KeychainRequest
requestPowerUp(username, amount, to?): KeychainRequest
requestPowerDown(username, vestingShares): KeychainRequest
requestDelegation(username, delegatee, vestingShares): KeychainRequest
requestClaimRewards({ username, rewardSteem?, rewardSbd?, rewardVests? }): KeychainRequest
requestWitnessVote(username, witness, approve?): KeychainRequest
requestProxy(username, proxy): KeychainRequest
requestBatch(username, requests: KeychainRequest[], keyType?): KeychainRequest
requestSignBuffer(username, data, keyType?): KeychainRequest
```

## Actions registry

```ts
ACTIONS: Readonly<ActionBuilders>            // the single construction source
buildAction(name, account, args): KeychainRequest   // typed; throws invalid-request
type ActionName = keyof ActionBuilders
type ActionArgs<N> = Parameters<…> minus the leading account
interface PostParams / ClaimRewardsParams / BatchInput
```

## Validation

```ts
validateOperations(ops, { expectedAccount? }): OperationsValidation   // { ok, error?, authority?, accounts? }
getRequiredAuthority(op): "posting" | "active"
batchAuthority(ops): "posting" | "active"
referencedAccounts(op): string[]
SUPPORTED_OPERATIONS: readonly string[]     // 48, frozen, serializer-synced
MAX_OPERATIONS_PER_REQUEST: number          // 20
```

## Errors

```ts
class SteemAuthError extends Error { readonly code: SteemAuthErrorCode }
isSteemAuthError(e): e is SteemAuthError
type SteemAuthErrorCode = "disposed" | "revoked" | "not-connected" | "no-account"
  | "session-expired" | "invalid-request" | "timeout" | "plane-timeout" | "plane-failed"
```

## Authentication

```ts
AuthenticateOptions { nonce?; expiresAt?; expiresInMs?; statement?; keyType? }
AuthenticateResult  { success; account?; nonce; issuedAt; expiresAt; message;
                      signature?; error? }
```

## Reactive state

```ts
new SteemAuthController(options: ControllerOptions)   // session options & { qr?, skipDataUrl? }
getState(): SteemAuthState        // immutable snapshot, stable between changes
subscribe(cb): () => void         // fires immediately
start(): Promise<void>            // may reject (mirrored into state)
refresh(): Promise<void>          // fresh session + QR
dispose(): void
request / action / all actions above (never throw → null)
signBuffer / authenticate / cancel
get session: SteemAuthSession | null

useSteemAuth(options): SteemAuthHook    // SteemAuthState + the same actions + start/refresh/dispose/controller

interface SteemAuthState {
  status: ConnectionStatus; account; error; errorCode; qr; expiresAt;
  expired; requesting; ready; loading; disposed;
}
```

## Transport & protocol

```ts
// relay plane (protocol v3 — the only transport; created in connect()
// from the QR's rt/rm + the app's own token)
createRelayPlane(opts: {
  relayUrl: string; room: string; token: string;
  create?: { appHash: string; phoneHash: string; ttlMs: number };
  onMessage(payload: unknown): void; onStatus?(s): void;
}): MessagePlane                       // { send, close, cursor }
MAX_ENVELOPE_BYTES: number             // 64 KB — same cap as the relay
MessagePlaneFactory = (o) => MessagePlane  // test seam (planeFactory option)
type MessagePlaneFactory = (o) => MessagePlane  // test seam (planeFactory option)

// protocol primitives
createQrPayload / serializeQrPayload / parseQrPayload
encryptMessage / decryptMessage                   // raw AES blob
sealMessage / openMessage                         // encrypt-then-MAC { c, m }
sha256Hex / hmacHex                               // token hashes + MAC key
generateRoom / generateToken                      // rm_/tok_ secrets (CSPRNG)
generateSessionKey / generateSessionId / randomNonce
ROOM_RE / TOKEN_RE / PROTOCOL_VERSION / PAYLOAD_TYPE / DEFAULT_SESSION_TTL_MS
DEFAULT_RELAY_URL: string                         // the shared relay plane
class ProtocolError extends Error
```

## Types

Wire: `SessionQrPayload` · `SessionMessage` · `Operation` · `KeyType` ·
`SignRequest` · `SealedEnvelope`

API: `KeychainRequest` · `KeychainResult` · `AuthenticateOptions` ·
`AuthenticateResult` · `CreateSessionOptions` · `ConnectionStatus`
