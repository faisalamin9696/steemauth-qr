/**
 * SteemAuthSession — the main entry point.
 *
 * Works out of the box: the default transport is the shared global relay
 * (DEFAULT_RELAY_URL), so no database setup, keys or projects are needed.
 * Self-host `steemauth-relay` and pass `relayUrl` for full isolation.
 *
 * Typical usage:
 *
 *   const session = new SteemAuthSession({ appName: 'SteemPro' });
 *
 *   session.onStatus((s) => console.log('session:', s));
 *   await session.connect();          // joins the relay room
 *   showQr(session.qrString);         // JSON payload to encode in a QR
 *
 *   const result = await session.request(
 *     requestVote('alice', 'bob', 'my-post', 100),
 *   );
 *   if (result.success) console.log(result.data?.txId);
 *
 *   session.dispose();
 */
import {
  DEFAULT_SESSION_TTL_MS,
  createQrPayload,
  generateToken,
  openMessage,
  sealMessage,
  generateSessionId,
  randomNonce,
  serializeQrPayload,
  sha256Hex,
} from './protocol';
import { createRelayPlane, type MessagePlane, type MessagePlaneFactory } from './relay-plane';
import { validateOperations } from './operations';
import { requestSignBuffer } from './requests';
import {
  buildAction,
  type ActionArgs,
  type ActionName,
  type BatchInput,
  type ClaimRewardsParams,
  type PostParams,
} from './actions';
import { SteemAuthError } from './errors';
import { toQrDataUrl, toQrSvg, type QrRenderOptions } from './qr';
import type {
  ConnectionStatus,
  CreateSessionOptions,
  KeyType,
  KeychainRequest,
  KeychainResult,
  Operation,
  SessionMessage,
  SessionQrPayload,
  AuthenticateOptions,
  AuthenticateResult,
} from './types';

export interface SteemAuthSessionOptions extends CreateSessionOptions {
  /** How long to wait for the mobile app to respond (default: QR TTL). */
  requestTimeoutMs?: number;
  /** How long `connect()` waits for the relay room handshake (default 15 s). */
  subscribeTimeoutMs?: number;
  /**
   * Keep the session (sid/key/handshake + in-flight request) in
   * `sessionStorage` so a page refresh can resume it instead of killing it.
   * Pair with `SteemAuthSession.resume()` — the controller and hook resume
   * automatically when this is set. Bounded by the QR TTL, cleared by
   * `dispose()`.
   */
  persistSession?: boolean;
  /**
   * Storage backend for `persistSession` (defaults to `sessionStorage`,
   * falling back to an in-memory map — which also keeps SSR safe).
   * Implement `{ getItem, setItem, removeItem }` to store it elsewhere.
   */
  storage?: SessionStorageLike;
  /**
   * Transport factory — primarily a test seam: inject an in-memory relay
   * with the same seq/replay semantics to run offline (see verify-e2e).
   * Production code leaves this unset (the WebSocket relay plane).
   */
  planeFactory?: MessagePlaneFactory;
}

interface PendingRequest {
  id: string;
  /** The original request — persisted so resume() can re-issue it. */
  req: KeychainRequest;
  method?: string;
  resolve: (r: KeychainResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SteemAuthSession {
  readonly payload: SessionQrPayload;
  /**
   * This side's room token — generated here, NEVER part of the QR (only its
   * sha256 hash goes to the relay at room registration). The phone uses the
   * QR's `tk`; possession of both tokens is what makes a peer legitimate.
   */
  private appTok: string;
  private options: SteemAuthSessionOptions;
  private pending = new Map<string, PendingRequest>();
  private readyInfo: { account: string; authority: string; device?: string } | null = null;
  private readyWaiters: Array<{
    resolve: (info: { account: string; authority: string; device?: string }) => void;
    reject: (e: Error) => void;
  }> = [];
  private joinWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private status: ConnectionStatus = 'connecting';
  private statusListeners: Array<(s: ConnectionStatus) => void> = [];
  private disposed = false;
  /** True once the user revoked this app in the authenticator. */
  private revoked = false;
  /** Why the session was revoked (surfaced to pending + new requests). */
  private revokeReason = 'Access was revoked in the authenticator.';
  /** True once the relay room has been joined at least once. */
  private joined = false;
  /** In-flight `connect()` promise, memoized so concurrent calls share it. */
  private connecting: Promise<void> | null = null;
  /** Durable transport (protocol v3) - the relay room, started in connect(). */
  private plane: MessagePlane | null = null;
  /** Re-issued request of a resumed session (never rejects — see resume()). */
  private _restoredRequest: Promise<KeychainResult> | null = null;

  constructor(options: SteemAuthSessionOptions, existingPayload?: SessionQrPayload) {
    this.options = options;
    this.payload = existingPayload ?? createQrPayload(options);
    this.appTok = generateToken();
  }

  /**
   * The request re-issued by `SteemAuthSession.resume()` when one was in
   * flight across a refresh. Always resolves — a failure becomes
   * `{ success: false, error }` so a fire-and-forget restore can never
   * produce an unhandled rejection.
   */
  get restoredRequest(): Promise<KeychainResult> | null {
    return this._restoredRequest;
  }

  /**
   * Rebuild a persisted session after a page refresh (enable with
   * `persistSession: true`). Returns `null` when there is nothing to resume
   * — no state, expired QR, or the relay rejected the rejoin (the snapshot
   * is kept in that last case so the next attempt can retry).
   *
   * On success the whole handshake is restored — connected account and
   * relay room — and any request that was in
   * flight is re-issued with the SAME id (receivers key pending state by
   * id: a re-show, not a duplicate). Await `session.restoredRequest` to
   * observe its outcome.
   *
   *   const session = await SteemAuthSession.resume({ appName: "My dApp" })
   *     ?? createFreshSession();
   */
  static async resume(
    options: SteemAuthSessionOptions = {} as SteemAuthSessionOptions,
  ): Promise<SteemAuthSession | null> {
    const store = storageOf(options.storage);
    let state: PersistedSession | null = null;
    try {
      const raw = store.getItem(STORAGE_KEY);
      state = raw ? (JSON.parse(raw) as PersistedSession) : null;
    } catch {
      state = null;
    }
    if (!state?.payload || typeof state.payload.k !== 'string') return null;
    // v2-era snapshots (no room/token fields) are not resumable — a fresh
    // QR is the honest fallback.
    if (typeof state.payload.rm !== 'string' || typeof state.payload.tk !== 'string') return null;
    if (state.payload.exp <= Date.now()) {
      state = null;
      try {
        store.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return null;
    }

    const session = new SteemAuthSession(
      {
        ...options,
        appName: options.appName ?? state.payload.app,
        persistSession: options.persistSession ?? true,
      },
      state.payload,
    );
    // The app token lives OUTSIDE the QR — it travels only in this snapshot.
    session.appTok = typeof state.ak === 'string' && state.ak.startsWith('tok_')
      ? state.ak
      : generateToken();
    try {
      await session.connect();
    } catch {
      // Relay unreachable right now: keep the snapshot (next refresh retries)
      // and report "nothing resumable" so the caller shows a fresh QR.
      session.markDeadQuietly();
      return null;
    }

    if (state.ready) {
      session.readyInfo = state.ready;
      session.setStatus('ready');
    }
    // The relay plane starts inside connect().
    session.persistState();

    const pending = state.pending;
    if (pending) {
      session._restoredRequest = session
        .request({ ...pending.req, id: pending.id })
        .catch((e): KeychainResult => ({
          id: pending.id,
          success: false,
          method: pending.req.method,
          error: e instanceof Error ? e.message : String(e),
        }));
    }
    return session;
  }

  /** Kill this instance without touching the persisted snapshot. */
  private markDeadQuietly(): void {
    this.disposed = true;
    this.teardownPlane();
    this.setStatus('disconnected');
  }

  /** The JSON string to encode into the QR code. */
  get qrString(): string {
    return serializeQrPayload(this.payload);
  }

  /** ms epoch when this QR expires (refresh by creating a new session). */
  get expiresAt(): number {
    return this.payload.exp;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** True once the user revoked this app in the authenticator. */
  get isRevoked(): boolean {
    return this.revoked;
  }

  /** Why the session was revoked, or null when it wasn't. */
  get revocationReason(): string | null {
    return this.revoked ? this.revokeReason : null;
  }

  /** Resolves when the mobile app scans and selects an account. */
  get account(): string | null {
    return this.readyInfo?.account ?? null;
  }

  // -------------------------------------------------------------------------
  // QR rendering conveniences (any QR library works — these are optional)
  // -------------------------------------------------------------------------

  qrSvg(options?: QrRenderOptions): Promise<string> {
    return toQrSvg(this.qrString, options);
  }

  qrDataUrl(options?: QrRenderOptions): Promise<string> {
    return toQrDataUrl(this.qrString, options);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register + join the QR's relay room. Call BEFORE showing the QR: the
   * browser must be listening before the phone can announce `ready` (as a
   * sealed row). Resolves once the room is live; rejects after
   * `subscribeTimeoutMs` — fail loudly instead of showing a QR nobody can
   * answer. A failed attempt tears the transport down so `connect()` can be
   * retried. Registration sends only TOKEN HASHES; the plaintext tokens
   * never leave the TLS socket.
   */
  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new SteemAuthError('disposed', 'Session already disposed'));
    if (this.revoked) return Promise.reject(new SteemAuthError('revoked', this.revokeReason));
    if (this.connecting && this.joined) return Promise.resolve(); // already live
    if (this.connecting) return this.connecting; // attempt in flight

    this.setStatus('connecting');
    this.teardownPlane(); // stale transport from a previous failed attempt
    const factory: MessagePlaneFactory = this.options.planeFactory ?? createRelayPlane;
    this.plane = factory({
      relayUrl: this.payload.rt,
      room: this.payload.rm,
      token: this.appTok,
      // Register the room BEFORE joining: hashes only, idempotent on resume.
      // The room lives a little past the QR so late approvals still land.
      create: {
        appHash: sha256Hex(this.appTok),
        phoneHash: sha256Hex(this.payload.tk),
        ttlMs: Math.max(this.payload.exp - Date.now(), 30_000) + 120_000,
      },
      handshakeTimeoutMs: this.options.subscribeTimeoutMs ?? 15_000,
      sid: this.payload.sid,
      onMessage: (payload) => this.handleMessage(payload),
      onRevoked: (reason) => this.applyRevocation(reason),
      onStatus: (status) => {
        if (this.disposed) return;
        if (status === 'connected') {
          this.joined = true;
          // Room live but nobody scanned — unless `ready` already arrived
          // (e.g. after a reconnect).
          this.setStatus(this.readyInfo ? 'ready' : 'waiting');
          this.flushJoinWaiters(null);
        } else if (status === 'failed') {
          // Allow a clean reconnect via connect().
          this.joined = false;
          this.connecting = null;
          this.flushJoinWaiters(
            new SteemAuthError('plane-failed', 'Relay connection failed — check the relayUrl and network'),
          );
          this.setStatus('failed');
        }
        // 'connecting' — handshake in progress (initial status)
      },
    });

    this.connecting = this.waitForJoin(this.options.subscribeTimeoutMs ?? 15_000).then(() => {
      // Plane live — snapshot now so a refresh right after connect resumes
      // instead of orphaning the QR the user is about to scan.
      this.persistState();
    }).catch(
      (e) => {
        // Join never completed — tear down so connect() can be retried
        // cleanly instead of pretending the plane is live.
        this.teardownPlane();
        this.joined = false;
        this.connecting = null;
        this.setStatus('failed');
        throw e;
      },
    );
    return this.connecting;
  }

  /** Resolves once the relay room is joined (or rejects on failure/timeout). */
  private waitForJoin(timeoutMs: number): Promise<void> {
    if (this.joined) return Promise.resolve();
    if (this.disposed) return Promise.reject(new SteemAuthError('disposed', 'Session disposed'));
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        this.joinWaiters = this.joinWaiters.filter((w) => w !== waiter);
        reject(
          new SteemAuthError('plane-timeout', 'Timed out joining the relay room — check the relayUrl and network'),
        );
      }, timeoutMs);
      this.joinWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private flushJoinWaiters(error: Error | null): void {
    for (const w of this.joinWaiters.splice(0)) {
      if (error) w.reject(error);
      else w.resolve();
    }
  }

  /**
   * Remove a pending request and mirror the change to persistent storage —
   * every settle path goes through here so a refresh never re-sends a
   * request that already timed out, resolved or was cancelled.
   */
  private settlePending(id: string): boolean {
    const had = this.pending.delete(id);
    if (had) this.persistState();
    return had;
  }

  /** Persist the resumable session snapshot (no-op unless `persistSession`). */
  private persistState(): void {
    if (!this.options.persistSession || this.disposed) return;
    try {
      const state: PersistedSession = { payload: this.payload, ak: this.appTok };
      if (this.readyInfo) state.ready = this.readyInfo;
      const first = this.pending.values().next().value as PendingRequest | undefined;
      if (first) state.pending = { id: first.id, req: first.req };
      storageOf(this.options.storage).setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full / private mode / SSR — persistence is best-effort;
      // the session simply behaves like a non-persistent one.
    }
  }

  /** Drop the persisted snapshot (dispose / revocation — session is over). */
  private clearPersisted(): void {
    try {
      storageOf(this.options.storage).removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Tear down the relay connection and reject any pending requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SteemAuthError('disposed', 'Session disposed'));
    }
    this.pending.clear();
    this.clearPersisted();
    this.teardownPlane();
    this.flushJoinWaiters(new SteemAuthError('disposed', 'Session disposed'));
    this.setStatus('disconnected');
  }

  /**
   * Tear the session down because the user revoked this app — a `revoke`
   * message sealed into the room log (durable: replay delivers it even if we
   * were offline when it was sent).
   *
   * Resolves every pending request as failed (a revoke is a normal outcome,
   * not an exception), wakes anyone parked on `waitForAccount()`, tears the
   * transport down, and marks `revoked` so `request()` fails fast forever
   * after. Idempotent.
   */
  private applyRevocation(reason: string): void {
    if (this.revoked || this.disposed) return;
    this.revoked = true;
    this.revokeReason = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        id,
        success: false,
        method: p.method,
        error: reason,
      });
    }
    this.pending.clear();
    this.clearPersisted();
    // Wake everyone parked on waitForAccount() — they must not hang on a
    // session that can never produce an account anymore.
    for (const w of this.readyWaiters.splice(0)) {
      w.reject(new SteemAuthError('revoked', reason));
    }
    this.teardownPlane();
    this.setStatus('revoked');
  }

  /** Close the relay room (dispose / revocation / failed attempt). */
  private teardownPlane(): void {
    this.plane?.close();
    this.plane = null;
  }


  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Subscribe to connection status changes. */
  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.push(cb);
    cb(this.status);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== cb);
    };
  }

  /**
   * Resolve when the mobile app has scanned the QR and chosen an account.
   * Resolves immediately if it already happened; **rejects** once the user
   * has revoked this app (the session can never produce an account again).
   */
  waitForAccount(): Promise<{ account: string; authority: string; device?: string }> {
    if (this.revoked) return Promise.reject(new SteemAuthError('revoked', this.revokeReason));
    if (this.readyInfo) return Promise.resolve(this.readyInfo);
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  // -------------------------------------------------------------------------
  // Requests (Keychain-style)
  // -------------------------------------------------------------------------

  /**
   * Send an operations request to the mobile app and await approval.
   * Build the request with the `request*` helpers or a plain KeychainRequest.
   *
   * The batch is validated first (shape, size, operation whitelist, account
   * reference) using the same rules the mobile app applies — invalid
   * requests reject immediately instead of failing after a QR scan.
   *
   * Expiry is **not** an option here: every ordinary request rides the QR's
   * own window (`payload.exp`, default 5 min). Only `authenticate()` carries
   * a client-settable expiry, exclusive to the authorization challenge.
   */
  request(req: KeychainRequest): Promise<KeychainResult> {
    return this.dispatch(req, this.payload.exp);
  }

  /**
   * Core of `request()` — identical validation/pending/timer machinery, with
   * the wire expiry passed in explicitly so the two clocks stay separate:
   * `request()` pins it to the QR window, `authenticate()` to the challenge
   * window. Private: no public path can set a custom expiry on a broadcast.
   */
  private dispatch(req: KeychainRequest, exp: number): Promise<KeychainResult> {
    if (this.revoked) {
      return Promise.reject(new SteemAuthError('revoked', this.revokeReason));
    }
    if (!this.plane) {
      return Promise.reject(new SteemAuthError('not-connected', 'Session not connected — call connect() first'));
    }
    if (Date.now() >= this.payload.exp) {
      return Promise.reject(new SteemAuthError('session-expired', 'Session expired — generate a fresh QR code'));
    }

    if (req.sign) {
      // Off-chain signing carries no operations, so the operation whitelist
      // does not apply — but a request can never be both, and it can only ask
      // for the account the phone is actually connected as.
      if (req.operations?.length) {
        return Promise.reject(
          new SteemAuthError('invalid-request', 'Request not sent — a sign request cannot also carry operations'),
        );
      }
      if (!req.sign.data) {
        return Promise.reject(
          new SteemAuthError('invalid-request', 'Request not sent — sign.data is required'),
        );
      }
      if (
        this.readyInfo?.account &&
        req.username &&
        req.username !== this.readyInfo.account
      ) {
        return Promise.reject(
          new SteemAuthError(
            'invalid-request',
            `Request not sent — the phone is connected as @${this.readyInfo.account}`,
          ),
        );
      }
    } else {
      const validation = validateOperations(req.operations, {
        expectedAccount: this.readyInfo?.account || undefined,
      });
      if (!validation.ok) {
        return Promise.reject(
          new SteemAuthError('invalid-request', `Request not sent — ${validation.error}`),
        );
      }
    }

    const id = req.id ?? cryptoRandomId();
    const timeoutMs =
      this.options.requestTimeoutMs ??
      this.options.ttlMs ??
      DEFAULT_SESSION_TTL_MS;

    const message: SessionMessage = {
      type: 'request',
      sid: this.payload.sid,
      id,
      ops: req.operations,
      sign: req.sign,
      action: req.method,
      meta: {
        description: req.description ?? req.method,
        page: req.callback,
      },
      exp,
    };

    return new Promise<KeychainResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePending(id);
        reject(
          new SteemAuthError('timeout', 'Timed out waiting for the mobile app — was the request shown and approved?'),
        );
      }, timeoutMs);

      this.pending.set(id, { id, req, method: req.method, resolve, reject, timer });
      this.persistState();

      this.sendEncrypted(message).catch((e) => {
        clearTimeout(timer);
        this.settlePending(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** Cancel a pending request (or all, when id is omitted). */
  cancel(id?: string, reason = 'User cancelled'): void {
    const targets = id ? [id] : [...this.pending.keys()];
    for (const target of targets) {
      this.sendEncrypted({
        type: 'cancel',
        sid: this.payload.sid,
        id: target,
        reason,
      }).catch(() => {});
      const p = this.pending.get(target);
      if (p) {
        clearTimeout(p.timer);
        this.settlePending(target);
        p.resolve({ id: target, success: false, method: p.method, error: reason });
      }
    }
  }

  /** Send a keepalive ping (optional — the mobile app answers automatically). */
  ping(): void {
    this.sendEncrypted({ type: 'ping', sid: this.payload.sid }).catch(() => {});
  }

  /** Number of requests waiting for the phone right now. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Zero-boilerplate actions — auto-fill the connected account
  //
  //   await session.vote("bob", "my-post", 100);
  //   await session.transfer("bob", "1.5", "thanks!");
  //
  // instead of request(requestVote(session.account!, ...)). They throw the
  // same fail-fast errors as request(); use the request* builders directly
  // when you need a different account or raw operations.
  // -------------------------------------------------------------------------

  /** The connected account, or a descriptive error. */
  private actingAccount(): string {
    const account = this.readyInfo?.account;
    if (!account) {
      throw new SteemAuthError('no-account', 'No authenticator connected yet — wait for waitForAccount() (status "ready") before acting');
    }
    return account;
  }

  /**
   * Run a typed action as the connected account. The named methods below are
   * thin typed aliases — one registry (src/actions.ts) builds every request,
   * so the session, controller and React hook can never drift apart.
   */
  action<N extends ActionName>(name: N, ...args: ActionArgs<N>): Promise<KeychainResult> {
    return this.request(buildAction(name, this.actingAccount(), args));
  }

  /** Upvote/downvote as the connected account (weight 0–100 %). */
  vote(...args: ActionArgs<'vote'>): Promise<KeychainResult> {
    return this.action('vote', ...args);
  }

  /** Transfer as the connected account. */
  transfer(...args: ActionArgs<'transfer'>): Promise<KeychainResult> {
    return this.action('transfer', ...args);
  }

  /** Publish or reply as the connected account. */
  post(params: PostParams): Promise<KeychainResult> {
    return this.action('post', params);
  }

  /** Send a custom_json (social / dApp payload) as the connected account. */
  customJson(...args: ActionArgs<'customJson'>): Promise<KeychainResult> {
    return this.action('customJson', ...args);
  }

  /** Broadcast raw operations as the connected account (all 48 op types). */
  broadcast(...args: ActionArgs<'broadcast'>): Promise<KeychainResult> {
    return this.action('broadcast', ...args);
  }

  /**
   * Sign a message off-chain and return the compact signature. Nothing is
   * broadcast — this is how an app proves a user holds the key without ever
   * seeing it (a Keychain `requestSignBuffer` equivalent, for login).
   */
  signBuffer(data: string, keyType: KeyType = 'Posting'): Promise<KeychainResult> {
    return this.request(requestSignBuffer(this.actingAccount(), data, keyType));
  }

  /**
   * Sign a structured login challenge off-chain (Keychain-style
   * `requestSignBuffer`, but shaped for sessions).
   *
   * `session.authenticate()` builds a human-readable challenge carrying a
   * **nonce** (auto-generated when omitted), an **expiry** (now + 5 min by
   * default), the session id, app and origin — then has the phone sign it
   * with the account's key. The phone records the app as an authorized
   * session, so the user can revoke it later from Sessions.
   *
   * Nothing is broadcast and the key never leaves the device. Send the
   * returned `message` + `signature` (+ `nonce`, `account`, `expiresAt`) to
   * your backend, verify the signature against the account's posting key,
   * check the nonce is fresh and the expiry hasn't passed, then issue your
   * own session token.
   *
   * ```ts
   * const auth = await session.authenticate();          // zero-config
   * // or pin your own challenge:
   * const auth = await session.authenticate({
   *   nonce: serverNonce,             // verify against YOUR nonce
   *   expiresInMs: 60_000,            // 1 minute
   *   statement: "Sign in to SteemPro",
   * });
   * if (auth.success) verify(auth.message, auth.signature, auth.account);
   * ```
   */
  async authenticate(options: AuthenticateOptions = {}): Promise<AuthenticateResult> {
    const account = this.actingAccount();
    const nonce = options.nonce ?? randomNonce();
    // The nonce is embedded as a single line of a structured message the
    // phone signs verbatim — control characters could inject fake fields.
    if (!/^[\x20-\x7e]+$/.test(nonce)) {
      throw new SteemAuthError('invalid-request', 'Request not sent — nonce must be printable ASCII without line breaks');
    }
    const issuedAt = Date.now();
    const expiresAt =
      options.expiresAt ?? issuedAt + (options.expiresInMs ?? 5 * 60_000);
    // Exclusive to this call: nothing here touches the QR/session window
    // (other requests keep the QR's expiry) — but a NaN from a bad
    // expiresInMs must not become an "Invalid Date" challenge.
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw new SteemAuthError('invalid-request', 'Request not sent — expiresAt must be in the future');
    }
    const statement = options.statement ?? `Sign in to ${this.payload.app}`;
    const keyType = options.keyType ?? 'Posting';

    // Stable, parseable shape (SIWE-inspired) — the phone shows it verbatim,
    // so a user can read exactly what they are proving.
    // Origin is the VERIFIED page origin (src — captured automatically and
    // never overridable, protocol.ts:149); payload.url is caller-declared
    // display text and must never attest identity (types/api.ts:122).
    // Non-browser minters may lack src; fall back to url, and finally to
    // 'unknown' rather than attesting a lie the phone can disprove via
    // its own appOrigin (src ?? url) display.
    const originLine = this.payload.src || this.payload.url || 'unknown';
    const message = [
      `${this.payload.app} wants you to sign in with your Steem account:`,
      account,
      '',
      statement,
      '',
      `Origin: ${originLine}`,
      `Session: ${this.payload.sid}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issuedAt).toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');

    const result = await this.dispatch(
      {
        username: account,
        operations: [],
        keyType,
        // Signals the phone this is an authenticate op → remember the app as a
        // revocable session (see markAppConnected in the mobile app).
        method: 'authenticate',
        description: statement,
        sign: { data: message, keyType },
      },
      // Exclusive clock: void the request once the challenge itself is stale.
      expiresAt,
    );

    return {
      success: result.success,
      account: result.account ?? account,
      nonce,
      issuedAt,
      expiresAt,
      message,
      signature: typeof result.data?.signature === 'string'
        ? result.data.signature
        : undefined,
      error: result.error,
    };
  }

  /** Power up (STEEM → SP) as the connected account. */
  powerUp(...args: ActionArgs<'powerUp'>): Promise<KeychainResult> {
    return this.action('powerUp', ...args);
  }

  /** Power down as the connected account (`vestingShares` in VESTS). */
  powerDown(...args: ActionArgs<'powerDown'>): Promise<KeychainResult> {
    return this.action('powerDown', ...args);
  }

  /** Delegate SP as the connected account (`vestingShares` in VESTS). */
  delegate(...args: ActionArgs<'delegate'>): Promise<KeychainResult> {
    return this.action('delegate', ...args);
  }

  /** Claim rewards as the connected account (amounts must match exactly). */
  claimRewards(params: ClaimRewardsParams): Promise<KeychainResult> {
    return this.action('claimRewards', params);
  }

  /** Approve (or remove) a witness vote as the connected account. */
  witnessVote(...args: ActionArgs<'witnessVote'>): Promise<KeychainResult> {
    return this.action('witnessVote', ...args);
  }

  /** Set the witness proxy ("" removes it) as the connected account. */
  setProxy(...args: ActionArgs<'setProxy'>): Promise<KeychainResult> {
    return this.action('setProxy', ...args);
  }

  /**
   * Merge several requests into ONE approval screen as the connected
   * account. Each entry is a builder result without `username`.
   */
  batch(requests: BatchInput[], keyType?: KeyType): Promise<KeychainResult> {
    return this.action('batch', requests, keyType);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private async sendEncrypted(message: SessionMessage): Promise<void> {
    if (!this.plane) throw new SteemAuthError('not-connected', 'Session not connected — call connect() first');
    // Durable by construction: the relay appends the sealed envelope to the
    // room log; replay catches anything that raced our subscription. The
    // envelope carries an HMAC the relay can neither read nor forge.
    await this.plane.send(sealMessage(message, this.payload.k));
  }

  private handleMessage(raw: unknown): void {
    // Encrypt-then-MAC: anything that fails HMAC verification or decryption
    // is dropped silently — a malicious relay has nothing it can inject.
    const message = openMessage(raw, this.payload.k);
    if (!message) return;
    if (message.sid !== this.payload.sid) return;

    switch (message.type) {
      case 'ready': {
        this.readyInfo = {
          account: message.account,
          authority: message.authority,
          device: message.device,
        };
        this.setStatus('ready');
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(this.readyInfo);
        this.persistState();
        break;
      }
      case 'result': {
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.settlePending(message.id);
        p.resolve({
          id: message.id,
          success: message.ok,
          method: p.method,
          account: message.account ?? this.readyInfo?.account,
          data: message.ok
            ? {
                txId: message.txId,
                signature: message.signature,
              }
            : undefined,
          error: message.error,
          message: message.ok ? 'Approved' : message.error,
        });
        break;
      }
      case 'cancel': {
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.settlePending(message.id);
        p.resolve({
          id: message.id,
          success: false,
          method: p.method,
          error: message.reason ?? 'Cancelled by the authenticator',
        });
        break;
      }
      case 'revoke': {
        // The user removed this app in the authenticator — delivered live
        // over the relay, or replayed from the room log after a reconnect.
        this.applyRevocation(message.reason ?? 'Access was revoked in the authenticator.');
        break;
      }
      case 'ping':
        this.sendEncrypted({ type: 'pong', sid: this.payload.sid }).catch(() => {});
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Session persistence (opt-in via `persistSession`) — the refresh/resume
// story. One snapshot: the payload, the handshake (ready/result endpoints)
// and the in-flight request. Bounded by the QR TTL, cleared by dispose.
// ---------------------------------------------------------------------------

/** Minimal storage contract — `sessionStorage` is compatible as-is. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedSession {
  payload: SessionQrPayload;
  /** The app's room token — never in the QR, survives only in this snapshot. */
  ak: string;
  ready?: { account: string; authority: string; device?: string };
  pending?: { id: string; req: KeychainRequest };
}

const STORAGE_KEY = 'steemauth.qr.session';
let memoryFallback: SessionStorageLike | null = null;

/** Explicit storage → global sessionStorage → in-memory (SSR-safe) map. */
function storageOf(override?: SessionStorageLike): SessionStorageLike {
  if (override) return override;
  try {
    const ls = (globalThis as { sessionStorage?: SessionStorageLike }).sessionStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    // Accessing sessionStorage can throw (privacy modes, sandboxed iframes).
  }
  if (!memoryFallback) {
    const map = new Map<string, string>();
    memoryFallback = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
      removeItem: (k) => {
        map.delete(k);
      },
    };
  }
  return memoryFallback;
}

function cryptoRandomId(): string {
  // Same secure source as the session id — request ids must never come from
  // Math.random.
  return generateSessionId();
}

