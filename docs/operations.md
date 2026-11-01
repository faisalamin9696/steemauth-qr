# Requesting operations

Everything the phone can do falls into three layers:

1. **Account-defaulted actions** — `session.vote(…)`, `auth.transfer(…)`,
   the hook's actions: they fill in the *connected account* for you.
2. **Typed builders** — `requestVote(user, …)`, `requestTransfer(…)`: plain
   objects for any account, including raw `request()`.
3. **`requestBroadcast`** — the escape hatch: any of the **48 supported
   operation types**, any combination, max 20 per request.

All of them produce the same `KeychainRequest` shape, all of them are
validated against the phone's *exact* rules **before** anything is sent.

## Account-defaulted actions

Available identically on `session`, the controller and the hook. Failures
never surprise you: construction problems throw a typed `invalid-request`
error (session) or land in `state.error` (controller/hook).

| Action | Example |
|---|---|
| `vote(author, permlink, weight%)` | `session.vote("bob", "my-post", 100)` |
| `transfer(to, amount, memo?)` | `session.transfer("bob", "1.500", "thanks!")` |
| `post({ title?, body, permlink, … })` | `session.post({ body: "Hello!", permlink: "hello" })` |
| `customJson(id, json, keyType?)` | `session.customJson("sm_follow", { follower, following })` |
| `broadcast(operations, keyType?)` | `session.broadcast([["comment_options", {…}]])` |
| `powerUp(amount, to?)` | `session.powerUp("2.500")` |
| `powerDown(vestingShares)` | `session.powerDown("10.000000 VESTS")` |
| `delegate(delegatee, vestingShares)` | `session.delegate("bob", "1000.000000 VESTS")` |
| `claimRewards({ rewardSteem?, … })` | `session.claimRewards({ rewardSteem: "0.100 STEEM", … })` |
| `witnessVote(witness, approve?)` | `session.witnessVote("good-guy")` |
| `setProxy(proxy)` | `session.setProxy("steempro")` · `setProxy("")` removes |
| `batch(requests, keyType?)` | one approval screen for several builder results |
| `action(name, ...args)` | generic typed form: `session.action("vote", "bob", "p", 100)` |

### Batch — many actions, one approval

```ts
await session.request(requestBatch(account, [
  requestVote(account, "bob", "my-post", 100),
  requestCustomJson(account, "my_dapp_reward", { user: account, post: "my-post" }),
]));
// → one screen on the phone, one transaction, one txId
```

The merged batch is checked at build time: max 20 ops, whitelist, one
account. `keyType` is derived from the merged operations.

## Every Steem operation (the full 48)

The phone signs the **complete operation set** its serializer implements.
Anything below works through `requestBroadcast` — and every single one is
proven end-to-end by the test suite (validated by the app's decoder **and**
binary-encoded by the app's serializer on every run):

<details>
<summary>All 48 supported operation types</summary>

```
account_create, account_create_with_delegation, account_update, account_update2,
account_witness_proxy, account_witness_vote, cancel_transfer_from_savings,
change_recovery_account, claim_account, claim_reward_balance,
collateralized_convert, comment, comment_options, convert, create_claimed_account,
create_proposal, custom, custom_binary, custom_json, decline_voting_rights,
delegate_vesting_shares, delete_comment, escrow_approve, escrow_dispute,
escrow_release, escrow_transfer, feed_publish, limit_order_cancel,
limit_order_create, limit_order_create2, recover_account, recurrent_transfer,
remove_proposal, report_over_production, request_account_recovery, reset_account,
set_reset_account, set_withdraw_vesting_route, transfer, transfer_from_savings,
transfer_to_savings, transfer_to_vesting, update_proposal, update_proposal_votes,
vote, withdraw_vesting, witness_set_properties, witness_update
```

</details>

```ts
import { SUPPORTED_OPERATIONS } from "@steempro/steemauth-qr";

SUPPORTED_OPERATIONS.length;                        // 48
SUPPORTED_OPERATIONS.includes("recurrent_transfer"); // true

// Any of them, e.g. a recurrent transfer + market order in one request:
await session.broadcast([
  ["recurrent_transfer", { from: account, to: "bob", amount: "1.000 STEEM",
    memo: "", recurrence: 24, executions: 5, extensions: [] }],
  ["limit_order_cancel", { owner: account, orderid: 7 }],
]);
```

Anything **not** in the list is refused client-side with
`Unsupported operation: <name>` — the same wording the phone would show.

## Key authority

The phone displays which key every request needs and never asks for more:

| Posting | Active |
|---|---|
| `vote`, `comment`, `delete_comment`, `claim_reward_balance`, `account_update2`, `custom_json` (posting auths) | everything else — transfers, power up/down, delegation, `custom_json` with `required_auths`, `account_update`, escrow, witnesses, proposals, … |

```ts
import { validateOperations, batchAuthority } from "@steempro/steemauth-qr";

const check = validateOperations(
  [["vote", { voter: "alice", author: "bob", permlink: "p", weight: 10000 }]],
  { expectedAccount: "alice" },     // optional — mirrors the phone's rule
);
// { ok: true, authority: "posting", accounts: ["alice", "bob"] }
```

`validateOperations(ops, { expectedAccount? })` enforces exactly what the
phone will: non-empty, ≤ 20 ops, `[name, params]` tuples with object
params, the whitelist, and (when given) that the batch involves the
expected account. Its error strings are byte-identical to the phone's.

`session.request()` runs this automatically — invalid requests throw
`Request not sent — …` **before touching the network**.

## Request object (raw form)

```ts
await session.request({
  username: account,
  operations: [["vote", { voter: account, author: "bob", permlink: "p", weight: 10000 }]],
  keyType: "Posting",           // advisory; the phone derives authority from ops
  method: "requestVote",        // display label
  description: "Upvote a post", // → meta.description on the phone
  callback: "/posts/123",       // → meta.page
  // no expiry field: ordinary requests always ride the QR window (5 min).
  // Only session.authenticate() takes a custom expiry — see authentication.
  id: "req-42",                 // correlation id (generated when omitted)
});
```

## Results

`session.request()` resolves with a `KeychainResult` (it *rejects* only for
local/timeout failures — see [errors](errors.md)):

| Outcome | Result |
|---|---|
| Approved & broadcast | `{ success: true, data: { txId }, account }` |
| User rejected | `{ success: false, error: "User rejected the request." }` |
| Cancelled (either side) | `{ success: false, error: <reason> }` |
| No answer in time | **rejects** — `Timed out waiting for the mobile app…` |

```ts
try {
  const result = await session.request(req);
  if (result.success) linkToExplorer(result.data?.txId);
  else showToast(result.error);
} catch (e) {
  // timeout / transport — show "try again"
}
session.cancel();               // abandon all pending (or cancel(id))
```

> **Rejecting ends the session.** When the user rejects, the phone closes
> the session (approving keeps it open for follow-up actions). Show a fresh
> QR before the next action if the last request was rejected.

## Amounts & weights (exactness rules)

- **Vote weight** is 0–100 (percent) like Keychain; converted to the chain's
  0–10000 scale.
- **Amounts** are formatted as exact strings, never through floating point:
  `"0.5"` → `"0.500 STEEM"`, `"1.234 SBD"` passes through, symbols are
  upper-cased, and **more than 3 decimal places is an error** — a request
  that would silently round your money is refused instead.
- **VESTS** arguments (`powerDown`, `delegation`) must be full VESTS asset
  strings, e.g. `"1000.000000 VESTS"`.
- **`claimRewards`** amounts must equal the account's *current* unclaimed
  rewards exactly — fetch them first; the chain rejects any mismatch.

## Next

- [Authentication](authentication.md) — off-chain signatures & login
- [Revocation](revocation.md) — when the user pulls access
- [Errors](errors.md) — typed failure codes
