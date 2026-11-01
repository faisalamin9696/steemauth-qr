/**
 * The account-defaulted action registry — the SINGLE source of truth behind
 * `session.vote(...)`, `controller.transfer(...)` and the hook's actions.
 *
 * Each builder receives the connected account as its first argument; the
 * session and the controller expose identical thin wrappers that differ only
 * in failure policy (the session throws, the controller records `error` and
 * resolves `null`). Defining each action exactly once — name, types,
 * construction — is what keeps the three surfaces from drifting.
 */
import {
  requestBatch,
  requestBroadcast,
  requestClaimRewards,
  requestCustomJson,
  requestDelegation,
  requestPost,
  requestPowerDown,
  requestPowerUp,
  requestProxy,
  requestTransfer,
  requestVote,
  requestWitnessVote,
} from './requests';
import { SteemAuthError } from './errors';
import type { KeychainRequest, KeyType, Operation } from './types';

/** Parameters for publishing — shared by `post()` and the builders. */
export interface PostParams {
  title?: string;
  body: string;
  permlink: string;
  parentAuthor?: string;
  parentPermlink?: string;
  jsonMetadata?: string | Record<string, unknown>;
}

/** Unclaimed-reward amounts for `claimRewards()` (must match the chain). */
export interface ClaimRewardsParams {
  rewardSteem?: string;
  rewardSbd?: string;
  rewardVests?: string;
}

/** One entry of a `batch()`: any builder result, `username` optional. */
export type BatchInput = Omit<KeychainRequest, 'username' | 'operations'> & {
  username?: string;
  operations: KeychainRequest['operations'];
};

/** Every account-defaulted action, with the connected account first. */
export interface ActionBuilders {
  vote(account: string, author: string, permlink: string, weight: number): KeychainRequest;
  transfer(account: string, to: string, amount: string, memo?: string): KeychainRequest;
  post(account: string, params: PostParams): KeychainRequest;
  customJson(
    account: string,
    id: string,
    json: string | Record<string, unknown>,
    keyType?: KeyType,
  ): KeychainRequest;
  broadcast(account: string, operations: Operation[], keyType?: KeyType): KeychainRequest;
  powerUp(account: string, amount: string, to?: string): KeychainRequest;
  powerDown(account: string, vestingShares: string): KeychainRequest;
  delegate(account: string, delegatee: string, vestingShares: string): KeychainRequest;
  claimRewards(account: string, params: ClaimRewardsParams): KeychainRequest;
  witnessVote(account: string, witness: string, approve?: boolean): KeychainRequest;
  setProxy(account: string, proxy: string): KeychainRequest;
  batch(account: string, requests: BatchInput[], keyType?: KeyType): KeychainRequest;
}

export type ActionName = keyof ActionBuilders;

/** Arguments of an action, minus the leading account. */
export type ActionArgs<N extends ActionName> =
  Parameters<ActionBuilders[N]> extends [string, ...infer Rest] ? Rest : never;

const IMPLEMENTATION: ActionBuilders = {
  vote: (account, author, permlink, weight) => requestVote(account, author, permlink, weight),
  transfer: (account, to, amount, memo) => requestTransfer(account, to, amount, memo),
  post: (account, params) => requestPost({ username: account, ...params }),
  customJson: (account, id, json, keyType) => requestCustomJson(account, id, json, keyType),
  broadcast: (account, operations, keyType) => requestBroadcast(account, operations, keyType),
  powerUp: (account, amount, to) => requestPowerUp(account, amount, to),
  powerDown: (account, vestingShares) => requestPowerDown(account, vestingShares),
  delegate: (account, delegatee, vestingShares) =>
    requestDelegation(account, delegatee, vestingShares),
  claimRewards: (account, params) => requestClaimRewards({ username: account, ...params }),
  witnessVote: (account, witness, approve) => requestWitnessVote(account, witness, approve),
  setProxy: (account, proxy) => requestProxy(account, proxy),
  batch: (account, requests, keyType) =>
    requestBatch(
      account,
      requests.map((r) => ({ ...r, username: account })),
      keyType,
    ),
};

export const ACTIONS: Readonly<ActionBuilders> = Object.freeze(IMPLEMENTATION);

/**
 * Build the KeychainRequest for an action. Construction failures (invalid
 * amounts, unsupported operations, mixed accounts, …) surface as typed
 * `invalid-request` errors — before anything is sent.
 */
export function buildAction<N extends ActionName>(
  name: N,
  account: string,
  args: ActionArgs<N>,
): KeychainRequest {
  const builder = ACTIONS[name] as (account: string, ...args: never[]) => KeychainRequest;
  try {
    return builder(account, ...(args as unknown as never[]));
  } catch (e) {
    throw new SteemAuthError('invalid-request', e instanceof Error ? e.message : String(e), {
      cause: e,
    });
  }
}
