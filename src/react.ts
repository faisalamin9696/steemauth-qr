/**
 * useSteemAuth() — the React binding. Import from the subpath:
 *
 *   import { useSteemAuth } from "@steempro/steemauth-qr/react";
 *
 * Minimal usage (the whole flow in a few lines):
 *
 *   const auth = useSteemAuth({ appName: "My dApp" });
 *
 *   if (auth.loading)            return <Spinner />;
 *   if (auth.error)              return <p>{auth.error}</p>;
 *   if (auth.ready)              return <p>Approve on your phone…</p>;
 *   return <div dangerouslySetInnerHTML={{ __html: auth.qr!.svg }} />;
 *
 *   // then, anywhere:  const res = await auth.transfer("bob", "1.5");
 *
 * Semantics:
 * - the session auto-starts on mount and disposes on unmount;
 * - action helpers NEVER throw — failures land in `auth.error` and the
 *   promise resolves to `null`; user outcomes come back as KeychainResult;
 * - `auth.refresh()` builds a fresh session + QR (after expiry/rejection).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SteemAuthController,
  type ControllerOptions,
  type SteemAuthState,
} from './controller';
import type { ActionArgs, ActionName } from './actions';
import type {
  AuthenticateOptions,
  AuthenticateResult,
  KeyType,
  KeychainRequest,
  KeychainResult,
  Operation,
} from './types';

/** State + bound actions returned by the hook. */
export interface SteemAuthHook extends SteemAuthState {
  /** Underlying controller (escape hatch). */
  controller: SteemAuthController;
  start(): Promise<void>;
  /** New session + new QR (after expiry or a rejection). */
  refresh(): Promise<void>;
  dispose(): void;
  request(req: KeychainRequest): Promise<KeychainResult | null>;
  /** Generic typed action — the named methods below are thin aliases. */
  action<N extends ActionName>(name: N, ...args: ActionArgs<N>): Promise<KeychainResult | null>;
  cancel(id?: string, reason?: string): void;
  // Zero-boilerplate actions — auto-use the connected account:
  vote(author: string, permlink: string, weight: number): Promise<KeychainResult | null>;
  transfer(to: string, amount: string, memo?: string): Promise<KeychainResult | null>;
  post(params: {
    title?: string;
    body: string;
    permlink: string;
    parentAuthor?: string;
    parentPermlink?: string;
    jsonMetadata?: string | Record<string, unknown>;
  }): Promise<KeychainResult | null>;
  customJson(
    id: string,
    json: string | Record<string, unknown>,
    keyType?: KeyType,
  ): Promise<KeychainResult | null>;
  broadcast(operations: Operation[], keyType?: KeyType): Promise<KeychainResult | null>;
  /** Sign a message off-chain; the compact signature is in `data.signature`. */
  signBuffer(data: string, keyType?: KeyType): Promise<KeychainResult | null>;
  /**
   * Sign a structured login challenge off-chain (nonce + expiry auto-filled
   * unless you pass your own). Returns the signed `message`, `signature`,
   * `nonce` and `expiresAt` for backend verification — or `null` on failure
   * (see `state.error`). The phone remembers the app as a revocable session.
   */
  authenticate(options?: AuthenticateOptions): Promise<AuthenticateResult | null>;
  powerUp(amount: string, to?: string): Promise<KeychainResult | null>;
  powerDown(vestingShares: string): Promise<KeychainResult | null>;
  delegate(delegatee: string, vestingShares: string): Promise<KeychainResult | null>;
  claimRewards(params: {
    rewardSteem?: string;
    rewardSbd?: string;
    rewardVests?: string;
  }): Promise<KeychainResult | null>;
  witnessVote(witness: string, approve?: boolean): Promise<KeychainResult | null>;
  setProxy(proxy: string): Promise<KeychainResult | null>;
  batch(
    requests: Array<Omit<KeychainRequest, 'username'> & { username?: string }>,
    keyType?: KeyType,
  ): Promise<KeychainResult | null>;
}

export type UseSteemAuthOptions = ControllerOptions;

const IDLE: SteemAuthState = {
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

/**
 * Create + connect a SteemAuthenticator session with reactive state.
 * Recreates the session only when option VALUES change (safe to pass an
 * inline object); disposes on unmount. SSR-safe (nothing runs on the
 * server — the first client render shows `loading`).
 */
export function useSteemAuth(options: UseSteemAuthOptions): SteemAuthHook {
  // Stable identity that still reacts to real value changes.
  const key = JSON.stringify(options);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<SteemAuthState>(IDLE);
  const controllerRef = useRef<SteemAuthController | null>(null);

  useEffect(() => {
    const controller = new SteemAuthController(optionsRef.current);
    controllerRef.current = controller;
    setState(controller.getState());
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    void controller.start().catch(() => {
      /* mirrored into state.error */
    });
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const call = useCallback(
    <T>(fn: (c: SteemAuthController) => T, fallback: T): T => {
      const c = controllerRef.current;
      return c ? fn(c) : fallback;
    },
    [],
  );

  return useMemo<SteemAuthHook>(
    () => ({
      ...state,
      controller: controllerRef.current as unknown as SteemAuthController,
      start: () => call((c) => c.start(), Promise.resolve()),
      refresh: () => call((c) => c.refresh(), Promise.resolve()),
      dispose: () => call((c) => c.dispose(), undefined),
      request: (req) => call((c) => c.request(req), Promise.resolve(null)),
      action: (name, ...args) =>
        call(
          (c) => (c.action as (n: typeof name, ...a: unknown[]) => Promise<KeychainResult | null>)(name, ...args),
          Promise.resolve(null),
        ),
      cancel: (id, reason) => call((c) => c.cancel(id, reason), undefined),
      vote: (author, permlink, weight) =>
        call((c) => c.vote(author, permlink, weight), Promise.resolve(null)),
      transfer: (to, amount, memo) =>
        call((c) => c.transfer(to, amount, memo), Promise.resolve(null)),
      post: (params) => call((c) => c.post(params), Promise.resolve(null)),
      customJson: (id, json, keyType) =>
        call((c) => c.customJson(id, json, keyType), Promise.resolve(null)),
      broadcast: (operations, keyType) =>
        call((c) => c.broadcast(operations, keyType), Promise.resolve(null)),
      signBuffer: (data, keyType) =>
        call((c) => c.signBuffer(data, keyType), Promise.resolve(null)),
      authenticate: (options) =>
        call((c) => c.authenticate(options), Promise.resolve(null)),
      powerUp: (amount, to) => call((c) => c.powerUp(amount, to), Promise.resolve(null)),
      powerDown: (vestingShares) => call((c) => c.powerDown(vestingShares), Promise.resolve(null)),
      delegate: (delegatee, vestingShares) =>
        call((c) => c.delegate(delegatee, vestingShares), Promise.resolve(null)),
      claimRewards: (params) => call((c) => c.claimRewards(params), Promise.resolve(null)),
      witnessVote: (witness, approve) =>
        call((c) => c.witnessVote(witness, approve), Promise.resolve(null)),
      setProxy: (proxy) => call((c) => c.setProxy(proxy), Promise.resolve(null)),
      batch: (requests, keyType) => call((c) => c.batch(requests, keyType), Promise.resolve(null)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, call],
  );
}
