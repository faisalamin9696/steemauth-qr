/**
 * SteemAuthController — a framework-agnostic reactive wrapper around a
 * session: connection status, account, error, rendered QR and request
 * activity as a single subscribable state object.
 *
 * This is what `useSteemAuth()` (React) is built on; use it directly from
 * Vue/Svelte/vanilla via `subscribe()`:
 *
 *   const auth = new SteemAuthController({ appName: "My dApp" });
 *   auth.subscribe(() => render(auth.getState()));
 *   auth.start();
 *   …
 *   await auth.transfer("bob", "1.5");     // null → see auth.getState().error
 *   auth.refresh();                        // fresh QR after expiry/rejection
 *   auth.dispose();
 *
 * State updates are immutable snapshots (stable references) — safe with
 * React's useSyncExternalStore / any "snapshot" style binding.
 */
import { SteemAuthSession, type SteemAuthSessionOptions } from './session';
import { toQrDataUrl, toQrSvg, type QrRenderOptions } from './qr';
import { requestSignBuffer } from './requests';
import {
  buildAction,
  type ActionArgs,
  type ActionName,
  type BatchInput,
  type ClaimRewardsParams,
  type PostParams,
} from './actions';
import { isSteemAuthError, messageOf, type SteemAuthErrorCode } from './errors';
import type {
  AuthenticateOptions,
  AuthenticateResult,
  ConnectionStatus,
  KeyType,
  KeychainRequest,
  KeychainResult,
} from './types';

/** Rendered QR, ready to display. */
export interface QrRender {
  /** SVG string — inject into the DOM. */
  svg: string;
  /** PNG data URL — use as `<img src>`. Empty when `skipDataUrl` is set. */
  dataUrl: string;
  /** Raw JSON payload — feed to your own QR renderer if you prefer. */
  qrString: string;
}

/** The single state object exposed by the controller / hook. */
export interface SteemAuthState {
  /** `connecting → waiting → ready` (+ `failed` / `disconnected`) */
  status: ConnectionStatus;
  /** connected account (null until the phone scans) */
  account: string | null;
  /** last local error (validation, timeout, relay) — user rejections are NOT here */
  error: string | null;
  /** machine-readable code for `error` (see SteemAuthErrorCode) */
  errorCode: SteemAuthErrorCode | null;
  /** rendered QR (null until the relay room is live) */
  qr: QrRender | null;
  /** QR expiry, ms epoch */
  expiresAt: number | null;
  /** true once the QR has expired — call refresh() */
  expired: boolean;
  /** a request is waiting for the phone right now */
  requesting: boolean;
  /** convenience: status === 'ready' */
  ready: boolean;
  /** convenience: connecting OR requesting */
  loading: boolean;
  /** dispose() was called */
  disposed: boolean;
}

const INITIAL: SteemAuthState = {
  status: 'connecting',
  account: null,
  error: null,
  errorCode: null,
  qr: null,
  expiresAt: null,
  expired: false,
  requesting: false,
  ready: false,
  loading: true,
  disposed: false,
};

export interface ControllerOptions extends SteemAuthSessionOptions {
  /** Rendering options for the built-in QR outputs. */
  qr?: QrRenderOptions;
  /** Skip the PNG render (SVG only — slightly faster). */
  skipDataUrl?: boolean;
}

export class SteemAuthController {
  private opts: ControllerOptions;
  private _session: SteemAuthSession | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SteemAuthState = INITIAL;
  private starting: Promise<void> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ControllerOptions) {
    this.opts = options;
  }

  /** The underlying session (null before start()). Escape hatch. */
  get session(): SteemAuthSession | null {
    return this._session;
  }

  // -------------------------------------------------------------------------
  // Store contract
  // -------------------------------------------------------------------------

  /** Current state snapshot (stable reference between changes). */
  getState(): SteemAuthState {
    return this.snapshot;
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private update(patch: Partial<SteemAuthState>): void {
    const next: SteemAuthState = { ...this.snapshot, ...patch };
    next.ready = next.status === 'ready';
    next.loading = next.status === 'connecting' || next.requesting;
    let changed = false;
    for (const k of Object.keys(next) as Array<keyof SteemAuthState>) {
      if (next[k] !== this.snapshot[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snapshot = next;
    for (const cb of [...this.listeners]) cb();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Build the session, join the relay room and render the QR. Idempotent;
   * a failed attempt resets so start() can be retried (or use refresh()).
   * Rejections are also mirrored into `state.error`.
   *
   * With `persistSession: true` a page refresh **resumes** the previous
   * session (same room, phone never noticed, in-flight request re-issued)
   * instead of minting a new one.
   */
  start(): Promise<void> {
    if (this.snapshot.disposed) {
      return Promise.reject(new Error('Controller already disposed'));
    }
    if (this.starting) return this.starting;

    this.starting = (async () => {
    const opts = this.opts;
      let resumed = false;
      let session: SteemAuthSession | null = null;
      if (opts.persistSession) {
        session = await SteemAuthSession.resume(opts);
        resumed = session !== null;
      }
      if (!session) session = new SteemAuthSession(opts);
      this.adopt(session);
      if (!resumed) await session.connect();
      await this.renderQr(session);
    })().catch((e) => {
      this._session?.dispose();
      this._session = null;
      this.starting = null;
      this.update({
        status: 'failed',
        error: messageOf(e),
        errorCode: isSteemAuthError(e) ? e.code : 'plane-failed',
      });
      throw e;
    });
    return this.starting;
  }

  /** Wire a session (fresh or resumed) into the store. */
  private adopt(session: SteemAuthSession): void {
    this._session = session;
    session.onStatus((s) => this.update({ status: s }));
    void session
      .waitForAccount()
      .then(({ account }) => {
        if (this._session === session) this.update({ account, error: null });
      })
      .catch(() => {
        /* disposed / revoked */
      });
  }

  /** Render the QR (or the resumed one) and arm expiry. */
  private async renderQr(session: SteemAuthSession): Promise<void> {
    const [svg, dataUrl] = await Promise.all([
      toQrSvg(session.qrString, this.opts.qr),
      this.opts.skipDataUrl
        ? Promise.resolve('')
        : toQrDataUrl(session.qrString, this.opts.qr),
    ]);
    if (this._session !== session) return; // disposed / refreshed meanwhile
    this.update({
      qr: { svg, dataUrl, qrString: session.qrString },
      expiresAt: session.expiresAt,
      expired: false,
    });
    this.armExpiry(session.expiresAt);
  }

  /**
   * The request `resume()` re-issued after a refresh (null when there was
   * nothing in flight or no session was restored). Never rejects.
   */
  get restoredRequest(): Promise<KeychainResult> | null {
    return this._session?.restoredRequest ?? null;
  }

  /** Tear down and build a FRESH session (new sid, key and QR). */
  refresh(): Promise<void> {
    this.teardown();
    this.update({
      status: 'connecting',
      account: null,
      error: null,
      errorCode: null,
      qr: null,
      expiresAt: null,
      expired: false,
      requesting: false,
    });
    this.starting = null;
    return this.start();
  }

  /** Leave the relay room and stop updating. Always call on unmount. */
  dispose(): void {
    if (this.snapshot.disposed) return;
    this.teardown();
    this.update({ status: 'disconnected', disposed: true });
    this.listeners.clear();
  }

  private teardown(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this._session?.dispose();
    this._session = null;
  }

  private armExpiry(expiresAt: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delay = Math.max(0, expiresAt - Date.now());
    this.expiryTimer = setTimeout(() => {
      this.update({ expired: true });
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Requests + zero-boilerplate actions (never throw — see docs)
  // -------------------------------------------------------------------------

  /**
   * Send a request. Never rejects: on local failure (invalid batch, timeout,
   * relay loss) the reason lands in `state.error` (+ `state.errorCode`) and
   * `null` is returned. User outcomes come back as a normal KeychainResult.
   */
  request(req: KeychainRequest): Promise<KeychainResult | null> {
    const session = this._session;
    if (!session) {
      this.fail('not-connected', 'Not connected — call start() first');
      return Promise.resolve(null);
    }
    this.update({ requesting: true });
    return session.request(req).then(
      (result) => {
        this.update({ requesting: false });
        return result;
      },
      (e) => {
        this.update({
          requesting: false,
          error: messageOf(e),
          errorCode: isSteemAuthError(e) ? e.code : null,
        });
        return null;
      },
    );
  }

  /** Record a typed failure in the state. */
  private fail(code: SteemAuthErrorCode, error: string): void {
    this.update({ error, errorCode: code });
  }

  /** Build a request with the connected account, then send it. */
  private run(build: (account: string) => KeychainRequest): Promise<KeychainResult | null> {
    if (!this._session) {
      this.fail('not-connected', 'Not connected — call start() first');
      return Promise.resolve(null);
    }
    const account = this.snapshot.account;
    if (!account) {
      this.fail('no-account', 'Not connected yet — waiting for the phone to scan the QR');
      return Promise.resolve(null);
    }
    try {
      return this.request(build(account));
    } catch (e) {
      this.fail(isSteemAuthError(e) ? e.code : 'invalid-request', messageOf(e));
      return Promise.resolve(null);
    }
  }

  /**
   * Run a typed action from the shared registry. The named methods below are
   * thin aliases — construction lives once in src/actions.ts.
   */
  action<N extends ActionName>(name: N, ...args: ActionArgs<N>): Promise<KeychainResult | null> {
    return this.run((account) => buildAction(name, account, args));
  }

  /** Upvote/downvote (weight 0–100 %). */
  vote(...args: ActionArgs<'vote'>): Promise<KeychainResult | null> {
    return this.action('vote', ...args);
  }

  /** Transfer ("1.5" → "1.500 STEEM"). */
  transfer(...args: ActionArgs<'transfer'>): Promise<KeychainResult | null> {
    return this.action('transfer', ...args);
  }

  /** Publish or reply. */
  post(params: PostParams): Promise<KeychainResult | null> {
    return this.action('post', params);
  }

  /** Send a custom_json payload. */
  customJson(...args: ActionArgs<'customJson'>): Promise<KeychainResult | null> {
    return this.action('customJson', ...args);
  }

  /** Broadcast raw operations (all 48 op types). */
  broadcast(...args: ActionArgs<'broadcast'>): Promise<KeychainResult | null> {
    return this.action('broadcast', ...args);
  }

  /**
   * Sign a message off-chain and return the compact signature
   * (Keychain `requestSignBuffer` equivalent). Nothing is broadcast — this is
   * how an app authenticates a user without ever touching a private key.
   * The signature is in `result.data.signature`.
   */
  signBuffer(data: string, keyType: KeyType = 'Posting'): Promise<KeychainResult | null> {
    return this.run((account) => requestSignBuffer(account, data, keyType));
  }

  /**
   * Sign a structured login challenge off-chain (nonce + expiry auto-filled
   * unless you pass your own). Nothing is broadcast and the key never leaves
   * the phone — send the returned `message` + `signature` to your backend and
   * verify them against the account's posting key. The phone remembers the
   * app as a revocable session (see the Sessions tab).
   *
   * Never rejects like the other actions: on failure `state.error` is set and
   * `null` is returned.
   *
   * ```ts
   * const auth = await auth.authenticate();             // zero-config
   * const auth = await auth.authenticate({ nonce: serverNonce });
   * if (auth) verify(auth.message, auth.signature, auth.account);
   * ```
   */
  authenticate(options: AuthenticateOptions = {}): Promise<AuthenticateResult | null> {
    const session = this._session;
    if (!session) {
      this.fail('not-connected', 'Not connected — call start() first');
      return Promise.resolve(null);
    }
    if (!this.snapshot.account) {
      this.fail('no-account', 'Not connected yet — waiting for the phone to scan the QR');
      return Promise.resolve(null);
    }
    this.update({ requesting: true });
    return session.authenticate(options).then(
      (result) => {
        this.update({ requesting: false, error: result.error ?? null });
        return result;
      },
      (e) => {
        this.update({
          requesting: false,
          error: messageOf(e),
          errorCode: isSteemAuthError(e) ? e.code : null,
        });
        return null;
      },
    );
  }

  /** Power up. */
  powerUp(...args: ActionArgs<'powerUp'>): Promise<KeychainResult | null> {
    return this.action('powerUp', ...args);
  }

  /** Power down (VESTS amount). */
  powerDown(...args: ActionArgs<'powerDown'>): Promise<KeychainResult | null> {
    return this.action('powerDown', ...args);
  }

  /** Delegate SP (VESTS amount). */
  delegate(...args: ActionArgs<'delegate'>): Promise<KeychainResult | null> {
    return this.action('delegate', ...args);
  }

  /** Claim rewards (amounts must match exactly). */
  claimRewards(params: ClaimRewardsParams): Promise<KeychainResult | null> {
    return this.action('claimRewards', params);
  }

  /** Approve (or remove) a witness vote. */
  witnessVote(...args: ActionArgs<'witnessVote'>): Promise<KeychainResult | null> {
    return this.action('witnessVote', ...args);
  }

  /** Set witness proxy ("" removes it). */
  setProxy(...args: ActionArgs<'setProxy'>): Promise<KeychainResult | null> {
    return this.action('setProxy', ...args);
  }

  /** Merge requests into ONE approval (each without `username`). */
  batch(requests: BatchInput[], keyType?: KeyType): Promise<KeychainResult | null> {
    return this.action('batch', requests, keyType);
  }

  /** Cancel a pending request (or all). */
  cancel(id?: string, reason?: string): void {
    this._session?.cancel(id, reason);
  }
}

