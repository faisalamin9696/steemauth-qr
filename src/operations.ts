/**
 * Client-side mirror of the mobile app's operation validation.
 *
 * The SteemAuthenticator app rejects anything it cannot serialize, decode or
 * display, so catching the same problems here fails fast in the developer's
 * browser instead of after a QR scan. The rules are copied from:
 *
 *   SteemAuthenticator/src/lib/steem/serializer.ts  (SUPPORTED_OPERATIONS)
 *   SteemAuthenticator/src/lib/steem/decoder.ts     (validateOperationBatch)
 *   SteemAuthenticator/src/lib/steem/transaction.ts (getRequiredAuthority)
 *
 * scripts/verify-protocol.ts imports the real mobile sources and asserts this
 * module stays in lockstep with them — any drift fails `npm test`.
 */
import type { Operation } from './types';

/**
 * Operation types the mobile app's serializer can encode — byte-identical to
 * `SUPPORTED_OPERATIONS` in the mobile app (verified by npm test).
 */
export const SUPPORTED_OPERATIONS: readonly string[] = Object.freeze(
  [
    'account_create',
    'account_create_with_delegation',
    'account_update',
    'account_update2',
    'account_witness_proxy',
    'account_witness_vote',
    'cancel_transfer_from_savings',
    'change_recovery_account',
    'claim_account',
    'claim_reward_balance',
    'collateralized_convert',
    'comment',
    'comment_options',
    'convert',
    'create_claimed_account',
    'create_proposal',
    'custom',
    'custom_binary',
    'custom_json',
    'decline_voting_rights',
    'delegate_vesting_shares',
    'delete_comment',
    'escrow_approve',
    'escrow_dispute',
    'escrow_release',
    'escrow_transfer',
    'feed_publish',
    'limit_order_cancel',
    'limit_order_create',
    'limit_order_create2',
    'recover_account',
    'recurrent_transfer',
    'remove_proposal',
    'report_over_production',
    'request_account_recovery',
    'reset_account',
    'set_reset_account',
    'set_withdraw_vesting_route',
    'transfer',
    'transfer_from_savings',
    'transfer_to_savings',
    'transfer_to_vesting',
    'update_proposal',
    'update_proposal_votes',
    'vote',
    'withdraw_vesting',
    'witness_set_properties',
    'witness_update',
  ].sort(),
);

/** Same account-name grammar the mobile app uses when collecting references. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,31}$/;

/** Same posting-only set as the mobile app's getRequiredAuthority(). */
const POSTING_OPERATIONS = new Set([
  'vote',
  'comment',
  'custom_json',
  'delete_comment',
  'claim_reward_balance',
  'account_update2',
]);

/** Highest key authority a single operation requires ('posting' | 'active'). */
export function getRequiredAuthority(operation: Operation): 'posting' | 'active' {
  const [type, params] = operation;
  if (type === 'custom_json') {
    const activeAuths: readonly unknown[] =
      (params as { required_auths?: readonly unknown[] })?.required_auths ?? [];
    return activeAuths.length > 0 ? 'active' : 'posting';
  }
  if (type === 'account_update') return 'active';
  return POSTING_OPERATIONS.has(type) ? 'posting' : 'active';
}

/** Highest authority required across a batch — same rule as the app. */
export function batchAuthority(operations: readonly Operation[]): 'posting' | 'active' {
  return operations.some((op) => getRequiredAuthority(op) === 'active')
    ? 'active'
    : 'posting';
}

/** The app refuses batches bigger than this. */
export const MAX_OPERATIONS_PER_REQUEST = 20;

/** Result of {@link validateOperations}. */
export interface OperationsValidation {
  ok: boolean;
  /** Human-readable reason when `ok` is false (same wording the app shows). */
  error?: string;
  /** Highest key authority the batch needs (present when `ok`). */
  authority?: 'posting' | 'active';
  /**
   * Best-effort set of account names referenced by the batch. This is a
   * superset of what the app extracts (it scans every string value), so an
   * expected account missing here is guaranteed to be missing on the phone.
   */
  accounts?: string[];
}

/** Collect every string value inside an operation's params (deep). */
function stringValues(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringValues(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) stringValues(v, out);
  }
  return out;
}

/** Account names referenced by one operation (best effort, see above). */
export function referencedAccounts(operation: Operation): string[] {
  const values = stringValues(operation[1], []);
  return [...new Set(values.filter((v) => ACCOUNT_NAME_RE.test(v)))];
}

/**
 * Validate an operations batch exactly the way the mobile app will before it
 * shows the approval screen:
 *
 *  - non-empty array, at most 20 entries
 *  - every entry is `[name, params]` with `params` a plain object
 *  - every `name` is in the app's serializer whitelist
 *  - (optional) at least one operation references `expectedAccount`
 *
 * Returns `{ ok: false, error }` with the same message the app would report.
 */
export function validateOperations(
  ops: unknown,
  options: { expectedAccount?: string } = {},
): OperationsValidation {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: 'Request contains no operations' };
  }
  if (ops.length > MAX_OPERATIONS_PER_REQUEST) {
    return {
      ok: false,
      error: `Too many operations in one request (max ${MAX_OPERATIONS_PER_REQUEST})`,
    };
  }

  const typed: Operation[] = [];
  for (const op of ops) {
    if (!Array.isArray(op) || op.length !== 2 || typeof op[0] !== 'string') {
      return { ok: false, error: 'Invalid operation: expected [name, params]' };
    }
    const [, params] = op;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { ok: false, error: `Invalid operation: "${op[0]}" params must be an object` };
    }
    if (!SUPPORTED_OPERATIONS.includes(op[0])) {
      return { ok: false, error: `Unsupported operation: ${op[0]}` };
    }
    typed.push(op as Operation);
  }

  const accounts = [...new Set(typed.flatMap(referencedAccounts))];

  if (options.expectedAccount && !accounts.includes(options.expectedAccount)) {
    return {
      ok: false,
      error: `Operations do not involve @${options.expectedAccount}`,
      accounts,
    };
  }

  return { ok: true, authority: batchAuthority(typed), accounts };
}
