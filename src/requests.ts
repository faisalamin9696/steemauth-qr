/**
 * SteemKeychain-style request builders.
 *
 * These produce plain `KeychainRequest` objects (operations arrays) that
 * `SteemAuthClient.request()` sends to the mobile app for approval. Field
 * names and semantics follow the Keychain JS API so existing integrations
 * port easily — see README for the mapping table.
 */
import type { KeychainRequest, KeyType, Operation } from './types';
import { validateOperations } from './operations';

/**
 * Format an amount exactly the way the chain expects: `"<digits>.<3 decimals>
 * <SYMBOL>"`. Pure string handling — no floating point, so large values and
 * user-supplied precision are never silently altered. More than 3 decimal
 * places (a rounding would change the amount) is rejected.
 */
const AMOUNT_RE = /^(\d+)(?:\.(\d+))?(?:\s+([A-Za-z]{2,10}))?$/;

function normalizeAmount(amount: string, symbol = 'STEEM'): string {
  const trimmed = String(amount ?? '').trim();
  if (!trimmed) throw new Error('amount is required');
  const match = AMOUNT_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid amount: "${amount}" — expected e.g. "1.234" or "1.234 ${symbol}"`,
    );
  }
  const [, whole, rawDecimals = '', currency] = match;
  let decimals = rawDecimals;
  if (decimals.length > 3) {
    // 1.123000 is unambiguous; 1.9999 would silently round up — refuse that.
    if (/^0+$/.test(decimals.slice(3))) {
      decimals = decimals.slice(0, 3);
    } else {
      throw new Error(
        `Invalid amount "${amount}": at most 3 decimal places (got ${decimals.length})`,
      );
    }
  }
  return `${whole}.${decimals.padEnd(3, '0')} ${(currency ?? symbol).toUpperCase()}`;
}

/** requestBroadcast — broadcast arbitrary operations (Keychain-compatible). */
export function requestBroadcast(
  username: string,
  operations: Operation[],
  keyType: KeyType = 'Posting',
): KeychainRequest {
  // Full client-side check: shape, batch size and the mobile app's operation
  // whitelist — the same rules the app applies after scanning.
  const validation = validateOperations(operations);
  if (!validation.ok) throw new Error(validation.error);
  return {
    username,
    operations,
    keyType,
    method: 'requestBroadcast',
  };
}

/**
 * requestSignBuffer — ask the phone to sign a message off-chain
 * (Keychain-compatible).
 *
 * This is how a dApp authenticates a user without ever handling a key: the
 * site generates a challenge, the phone signs it with the account's key, and
 * the site verifies the compact signature against the account's public key.
 * Nothing is broadcast and nothing is written to the chain.
 *
 * `data` is displayed verbatim on the phone — keep it short and make sure it
 * identifies the requesting app, so a user can tell what they are signing.
 */
export function requestSignBuffer(
  username: string,
  data: string,
  keyType: KeyType = 'Posting',
): KeychainRequest {
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('data is required');
  }
  if (data.length > 4096) {
    throw new Error(
      'data is too long to show on the phone (max 4096 characters)',
    );
  }
  return {
    username,
    // Nothing to broadcast — the phone signs `data` and returns a signature.
    operations: [],
    keyType,
    method: 'requestSignBuffer',
    sign: { data, keyType },
  };
}

/** requestVote — weight is 0..100 (percent), like Keychain. */
export function requestVote(
  username: string,
  author: string,
  permlink: string,
  weight: number,
): KeychainRequest {
  if (!author || !permlink) throw new Error('author and permlink are required');
  const pct = Number(weight);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error('weight must be between 0 and 100 (percent)');
  }
  return {
    username,
    operations: [
      ['vote', { voter: username, author, permlink, weight: Math.round(pct * 100) }],
    ],
    keyType: 'Posting',
    method: 'requestVote',
  };
}

/** requestTransfer — amount like "0.001" or "0.001 STEEM". Always Active. */
export function requestTransfer(
  username: string,
  to: string,
  amount: string,
  memo = '',
  keyType: KeyType = 'Active',
): KeychainRequest {
  if (!to) throw new Error('to is required');
  return {
    username,
    operations: [
      ['transfer', { from: username, to, amount: normalizeAmount(amount), memo }],
    ],
    keyType,
    method: 'requestTransfer',
  };
}

/** requestPost — publish (parentAuthor/parentPermlink empty = new post). */
export function requestPost(params: {
  username: string;
  title?: string;
  body: string;
  permlink: string;
  parentAuthor?: string;
  parentPermlink?: string;
  jsonMetadata?: string | Record<string, unknown>;
}): KeychainRequest {
  const {
    username,
    title = '',
    body,
    permlink,
    parentAuthor = '',
    parentPermlink = 'steem',
    jsonMetadata = '{}',
  } = params;
  if (!body) throw new Error('body is required');
  if (!permlink) throw new Error('permlink is required');
  const json =
    typeof jsonMetadata === 'string'
      ? jsonMetadata
      : JSON.stringify(jsonMetadata);
  return {
    username,
    operations: [
      [
        'comment',
        {
          parent_author: parentAuthor,
          parent_permlink: parentPermlink,
          author: username,
          permlink,
          title,
          body,
          json_metadata: json,
        },
      ],
    ],
    keyType: 'Posting',
    method: 'requestPost',
  };
}

/** requestCustomJson — Keychain-compatible social/market ops. */
export function requestCustomJson(
  username: string,
  id: string,
  json: string | Record<string, unknown>,
  keyType: KeyType = 'Posting',
): KeychainRequest {
  if (!id) throw new Error('id is required');
  const payload = typeof json === 'string' ? json : JSON.stringify(json);
  const active = keyType === 'Active' || keyType === 'Owner';
  return {
    username,
    operations: [
      [
        'custom_json',
        {
          required_auths: active ? [username] : [],
          required_posting_auths: active ? [] : [username],
          id,
          json: payload,
        },
      ],
    ],
    keyType,
    method: 'requestCustomJson',
  };
}

/** requestPowerUp — transfer_to_vesting (STEEM → SP). */
export function requestPowerUp(
  username: string,
  amount: string,
  to = username,
): KeychainRequest {
  return {
    username,
    operations: [
      ['transfer_to_vesting', { from: username, to, amount: normalizeAmount(amount) }],
    ],
    keyType: 'Active',
    method: 'requestPowerUp',
  };
}

/**
 * requestPowerDown — withdraw_vesting. `vestingShares` must be a VESTS
 * amount, e.g. "100.000000 VESTS" (the app signs exactly what you send).
 */
export function requestPowerDown(
  username: string,
  vestingShares: string,
): KeychainRequest {
  if (!/VESTS$/i.test(String(vestingShares ?? '').trim())) {
    throw new Error('vestingShares must be a VESTS amount, e.g. "100.000000 VESTS"');
  }
  return {
    username,
    operations: [['withdraw_vesting', { account: username, vesting_shares: vestingShares.trim() }]],
    keyType: 'Active',
    method: 'requestPowerDown',
  };
}

/**
 * requestDelegation — delegate_vesting_shares. `vestingShares` is a VESTS
 * amount, e.g. "1000.000000 VESTS".
 */
export function requestDelegation(
  username: string,
  delegatee: string,
  vestingShares: string,
): KeychainRequest {
  if (!delegatee) throw new Error('delegatee is required');
  if (!/VESTS$/i.test(String(vestingShares ?? '').trim())) {
    throw new Error('vestingShares must be a VESTS amount, e.g. "1000.000000 VESTS"');
  }
  return {
    username,
    operations: [
      [
        'delegate_vesting_shares',
        { delegator: username, delegatee, vesting_shares: vestingShares.trim() },
      ],
    ],
    keyType: 'Active',
    method: 'requestDelegation',
  };
}

/**
 * requestClaimRewards — claim_reward_balance. Amounts must match the
 * account's current unclaimed rewards exactly (fetch them first).
 */
export function requestClaimRewards(params: {
  username: string;
  rewardSteem?: string;
  rewardSbd?: string;
  rewardVests?: string;
}): KeychainRequest {
  const { username, rewardSteem, rewardSbd, rewardVests } = params;
  return {
    username,
    operations: [
      [
        'claim_reward_balance',
        {
          account: username,
          reward_steem: rewardSteem ?? normalizeAmount('0'),
          reward_sbd: rewardSbd ?? normalizeAmount('0', 'SBD'),
          reward_vests: rewardVests ?? '0.000000 VESTS',
        },
      ],
    ],
    keyType: 'Posting',
    method: 'requestClaimRewards',
  };
}

/**
 * requestBatch — merge several builder results into ONE request, so the
 * phone shows a single approval screen for the whole batch (e.g. a vote
 * plus a custom_json in one tap). Total ops still limited to 20.
 */
export function requestBatch(
  username: string,
  requests: KeychainRequest[],
  keyType?: KeyType,
): KeychainRequest {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('requests must be a non-empty array of KeychainRequest');
  }
  const operations: Operation[] = [];
  const methods: string[] = [];
  for (const req of requests) {
    if (!req || !Array.isArray(req.operations) || req.operations.length === 0) {
      throw new Error('each request must carry a non-empty operations array');
    }
    if (req.username !== username) {
      throw new Error(
        `all requests in a batch must target the same account (@${username})`,
      );
    }
    operations.push(...req.operations);
    if (req.method) methods.push(req.method);
  }
  // Validate the merged batch with the same rules the phone applies.
  const validation = validateOperations(operations, { expectedAccount: username });
  if (!validation.ok) throw new Error(validation.error);

  const needsActive =
    validation.authority === 'active' ||
    requests.some((r) => r.keyType === 'Active' || r.keyType === 'Owner');
  return {
    username,
    operations,
    keyType: keyType ?? (needsActive ? 'Active' : 'Posting'),
    method: 'requestBatch',
    description: methods.length ? [...new Set(methods)].join(' + ') : undefined,
  };
}

/**
 * requestWitnessVote — approve or remove a witness vote
 * (account_witness_vote). Authority: Active.
 */
export function requestWitnessVote(
  username: string,
  witness: string,
  approve = true,
): KeychainRequest {
  if (!witness) throw new Error('witness is required');
  return {
    username,
    operations: [['account_witness_vote', { account: username, witness, approve }]],
    keyType: 'Active',
    method: 'requestWitnessVote',
  };
}

/**
 * requestProxy — set a witness proxy (account_witness_proxy); pass an empty
 * string to remove the current proxy. Authority: Active.
 */
export function requestProxy(username: string, proxy: string): KeychainRequest {
  return {
    username,
    operations: [['account_witness_proxy', { account: username, proxy }]],
    keyType: 'Active',
    method: 'requestProxy',
  };
}
