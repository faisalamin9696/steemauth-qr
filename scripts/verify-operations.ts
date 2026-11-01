/**
 * Full Steem operations matrix — proves the package supports EVERY operation
 * the mobile app can sign (all 48), end to end:
 *
 *   package validateOperations  ──┐
 *                                  ├── same verdicts, same authority
 *   mobile validateOperationBatch ─┘
 *   mobile serializeOperation     ── binary encoding actually succeeds
 *
 * The fixture list must cover every entry of SUPPORTED_OPERATIONS — a newly
 * whitelisted operation without a fixture FAILS this test, so the matrix can
 * never silently fall behind the app.
 *
 * Run: npx tsx scripts/verify-operations.ts
 */
import { SUPPORTED_OPERATIONS, validateOperations } from '../src/operations';
import { mobile } from './mobile';

// The app's validator + serializer + byte writer, loaded from the live
// checkout (scripts/mobile.ts).
const { validateOperationBatch } = mobile.decoder;
const {
  serializeOperation,
  SUPPORTED_OPERATIONS: MOBILE_SUPPORTED_OPERATIONS,
} = mobile.serializer;
const { ByteWriter } = mobile.bytes;

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('      ', JSON.stringify(extra));
  }
}

// ---------------------------------------------------------------------------
// Fixtures: one structurally valid instance per operation. Every fixture
// references @alice (the "connected account") so the account rule holds too.
// ---------------------------------------------------------------------------
const NULL_PUBKEY = 'STM1111111111111111111111111111111114T1Anm';
const AUTH = { weight_threshold: 1, account_auths: [] as [string, number][], key_auths: [] as [string, number][] };
const DATE = '2030-01-01T00:00:00';
const HEADER = {
  previous: '0'.repeat(40), // 20 bytes hex
  timestamp: '2020-01-01T00:00:00',
  witness: 'bob',
  transaction_merkle_root: '0'.repeat(40),
  extensions: [],
  witness_signature: '0'.repeat(130), // 65 bytes hex
};

const FIXTURES: Record<string, Record<string, unknown>> = {
  account_create: {
    fee: '3.000 STEEM', creator: 'alice', new_account_name: 'steemuser1',
    owner: AUTH, active: AUTH, posting: AUTH, memo_key: NULL_PUBKEY, json_metadata: '{}',
  },
  account_create_with_delegation: {
    fee: '3.000 STEEM', delegation: '0.000000 VESTS', creator: 'alice', new_account_name: 'steemuser1',
    owner: AUTH, active: AUTH, posting: AUTH, memo_key: NULL_PUBKEY, json_metadata: '{}', extensions: [],
  },
  account_update: {
    account: 'alice', owner: null, active: null, posting: null, memo_key: NULL_PUBKEY, json_metadata: '{}',
  },
  account_update2: {
    account: 'alice', owner: null, active: null, posting: null, memo_key: NULL_PUBKEY,
    json_metadata: '{}', posting_json_metadata: '{}', extensions: [],
  },
  account_witness_proxy: { account: 'alice', proxy: 'bob' },
  account_witness_vote: { account: 'alice', witness: 'bob', approve: true },
  cancel_transfer_from_savings: { from: 'alice', request_id: 1 },
  change_recovery_account: { account_to_recover: 'alice', new_recovery_account: 'bob', extensions: [] },
  claim_account: { creator: 'alice', fee: '3.000 STEEM', extensions: [] },
  claim_reward_balance: {
    account: 'alice', reward_steem: '0.000 STEEM', reward_sbd: '0.000 SBD', reward_vests: '0.000000 VESTS',
  },
  collateralized_convert: { owner: 'alice', requestid: 1, amount: '1.000 SBD' },
  comment: {
    parent_author: '', parent_permlink: 'steem', author: 'alice', permlink: 'hello',
    title: 'Hello', body: 'World', json_metadata: '{}',
  },
  comment_options: {
    author: 'alice', permlink: 'hello', max_accepted_payout: '1000.000 SBD',
    percent_steem_dollars: 10000, allow_votes: true, allow_curation_rewards: true, extensions: [],
  },
  convert: { owner: 'alice', requestid: 1, amount: '1.000 SBD' },
  create_claimed_account: {
    creator: 'alice', new_account_name: 'steemuser1', owner: AUTH, active: AUTH, posting: AUTH,
    memo_key: NULL_PUBKEY, json_metadata: '{}', extensions: [],
  },
  create_proposal: {
    creator: 'alice', receiver: 'bob', start_date: DATE, end_date: DATE, daily_pay: '1.000 SBD',
    subject: '.dev', permlink: 'dev-proposal', extensions: [],
  },
  custom: { required_auths: ['alice'], id: 1, data: '' },
  custom_binary: {
    required_owner_auths: [], required_active_auths: [], required_posting_auths: ['alice'],
    required_auths: [], id: 'test', data: '',
  },
  custom_json: {
    required_auths: [], required_posting_auths: ['alice'], id: 'sm_test', json: '{}',
  },
  decline_voting_rights: { account: 'alice', decline: true },
  delegate_vesting_shares: { delegator: 'alice', delegatee: 'bob', vesting_shares: '0.000000 VESTS' },
  delete_comment: { author: 'alice', permlink: 'hello' },
  escrow_approve: { from: 'alice', to: 'bob', agent: 'carol', who: 'carol', escrow_id: 1, approve: true },
  escrow_dispute: { from: 'alice', to: 'bob', agent: 'carol', who: 'alice', escrow_id: 1 },
  escrow_release: {
    from: 'alice', to: 'bob', agent: 'carol', who: 'alice', receiver: 'bob', escrow_id: 1,
    sbd_amount: '0.000 SBD', steem_amount: '1.000 STEEM',
  },
  escrow_transfer: {
    from: 'alice', to: 'bob', sbd_amount: '0.000 SBD', steem_amount: '1.000 STEEM', escrow_id: 1,
    agent: 'carol', fee: '0.000 STEEM', json_meta: '{}',
    ratification_deadline: DATE, escrow_expiration: DATE,
  },
  feed_publish: { publisher: 'alice', exchange_rate: { base: '1.000 STEEM', quote: '0.500 SBD' } },
  limit_order_cancel: { owner: 'alice', orderid: 1 },
  limit_order_create: {
    owner: 'alice', orderid: 1, amount_to_sell: '1.000 STEEM', min_to_receive: '0.500 SBD',
    fill_or_kill: false, expiration: DATE,
  },
  limit_order_create2: {
    owner: 'alice', orderid: 1, amount_to_sell: '1.000 STEEM',
    exchange_rate: { base: '1.000 STEEM', quote: '0.500 SBD' }, fill_or_kill: false, expiration: DATE,
  },
  recover_account: {
    account_to_recover: 'alice', new_owner_authority: AUTH, recent_owner_authority: AUTH, extensions: [],
  },
  recurrent_transfer: {
    from: 'alice', to: 'bob', amount: '1.000 STEEM', memo: '', recurrence: 24, executions: 5, extensions: [],
  },
  remove_proposal: { proposal_owner: 'alice', proposal_ids: [1], extensions: [] },
  report_over_production: { reporter: 'alice', first_block: HEADER, second_block: HEADER },
  request_account_recovery: {
    recovery_account: 'alice', account_to_recover: 'bob', new_owner_authority: AUTH, extensions: [],
  },
  reset_account: { reset_account: 'alice', account_to_reset: 'bob', new_owner_authority: AUTH },
  set_reset_account: { account: 'alice', current_reset_account: '', reset_account: 'bob' },
  set_withdraw_vesting_route: { from_account: 'alice', to_account: 'bob', percent: 10000, auto_vest: false },
  transfer: { from: 'alice', to: 'bob', amount: '1.000 STEEM', memo: '' },
  transfer_from_savings: { from: 'alice', request_id: 1, to: 'bob', amount: '1.000 STEEM', memo: '' },
  transfer_to_savings: { from: 'alice', to: 'bob', amount: '1.000 STEEM', memo: '' },
  transfer_to_vesting: { from: 'alice', to: 'alice', amount: '1.000 STEEM' },
  update_proposal: {
    proposal_id: 1, creator: 'alice', daily_pay: '2.000 SBD', subject: '.dev',
    permlink: 'dev-proposal', extensions: [],
  },
  update_proposal_votes: { voter: 'alice', proposal_ids: [1], approve: true, extensions: [] },
  vote: { voter: 'alice', author: 'bob', permlink: 'hello', weight: 10000 },
  withdraw_vesting: { account: 'alice', vesting_shares: '1.000000 VESTS' },
  witness_set_properties: { owner: 'alice', props: [['properties', '']], extensions: [] },
  witness_update: {
    owner: 'alice', url: 'https://example.com', block_signing_key: NULL_PUBKEY,
    props: { account_creation_fee: '3.000 STEEM', maximum_block_size: 131072, sbd_interest_rate: 0 },
    fee: '3.000 STEEM',
  },
};

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
check(
  'package whitelist identical to the mobile serializer',
  JSON.stringify(SUPPORTED_OPERATIONS) === JSON.stringify(MOBILE_SUPPORTED_OPERATIONS),
);

let missingFixtures = 0;
for (const name of SUPPORTED_OPERATIONS) {
  const params = FIXTURES[name];
  if (!params) {
    check(`fixture exists for ${name} — add one when the app whitelists new ops`, false);
    missingFixtures++;
    continue;
  }
  const ops = [[name, params]];

  const pkg = validateOperations(ops, { expectedAccount: 'alice' });
  const mob = validateOperationBatch(ops, { expectedAccount: 'alice' });

  check(
    ` ${name}: accepted by package AND app (same authority, account rule holds)`,
    pkg.ok && mob.ok && pkg.authority === mob.authority,
    { pkg: { ok: pkg.ok, error: pkg.error }, mob: { ok: mob.ok, error: mob.error } },
  );

  // The app must be able to BINARY-ENCODE it — this is what actually gets
  // signed and broadcast after the user approves.
  let bytes = 0;
  let encodeError = '';
  try {
    const b = new ByteWriter(4096);
    serializeOperation(b, [name, params]);
    bytes = b.toBytes().length;
  } catch (e) {
    encodeError = e instanceof Error ? e.message : String(e);
  }
  check(` ${name}: serializes to ${bytes} bytes on the app side`, bytes > 0, encodeError);
}

check('every supported operation has a fixture', missingFixtures === 0, {
  total: SUPPORTED_OPERATIONS.length,
});

// ---------------------------------------------------------------------------
// Mixed mega-batch: 20 heterogeneous ops in ONE request (the protocol max)
// ---------------------------------------------------------------------------
const megaOps = SUPPORTED_OPERATIONS.slice(0, 20).map((n) => [n, FIXTURES[n]!]);
const megaPkg = validateOperations(megaOps, { expectedAccount: 'alice' });
const megaMob = validateOperationBatch(megaOps, { expectedAccount: 'alice' });
check(
  'max-size mixed batch (20 ops) accepted by both with the same authority',
  megaPkg.ok && megaMob.ok && megaPkg.authority === megaMob.authority,
  { pkg: megaPkg.error, mob: megaMob.error },
);
let megaBytes = 0;
try {
  const b = new ByteWriter(8192);
  for (const op of megaOps) serializeOperation(b, op as [string, Record<string, unknown>]);
  megaBytes = b.toBytes().length;
} catch {
  /* counted as failure below */
}
check('max-size mixed batch serializes on the app side', megaBytes > 0, { megaBytes });

console.log(
  failures === 0
    ? `\nAll ${SUPPORTED_OPERATIONS.length} operations verified ✔`
    : `\n${failures} operation check(s) FAILED ✘`,
);
process.exit(failures === 0 ? 0 : 1);
