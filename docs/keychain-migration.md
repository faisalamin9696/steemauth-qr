# SteemKeychain migration

Most Keychain integrations port with **rename-only** changes: same builder
names, same semantics, results as a promise instead of a callback.

## Before / after

| SteemKeychain | `@steempro/steemauth-qr` |
|---|---|
| `requestVote(user, author, permlink, weight)` | ✅ identical — weight 0–100 % |
| `requestTransfer(user, to, amount, memo)` | ✅ identical |
| `requestPost({ … })` | `requestPost({ username, title?, body, permlink, parentAuthor?, parentPermlink?, jsonMetadata? })` |
| `requestCustomJson(user, id, json, keyType)` | ✅ identical |
| `requestBroadcast(user, ops, keyType)` | `requestBroadcast(user, operations, keyType)` |
| `requestSignBuffer(user, buffer, keyType)` | ✅ `session.signBuffer(data, keyType)` — plus structured `session.authenticate()` for login |
| `requestProveOwnership` / memo encryption | ❌ not in v1 (on-chain operations only) |
| — | ➕ `requestPowerUp`, `requestPowerDown`, `requestDelegation`, `requestClaimRewards`, `requestWitnessVote`, `requestProxy`, `requestBatch` |

## Structural differences (all improvements)

| Keychain | This package |
|---|---|
| `window.steem_keychain.requestX(...)` global + callback | an explicit session object + promises |
| inject a script tag, depend on a wallet extension installed | the user only needs the **SteemAuthenticator app**; nothing injected |
| request id correlation manual | built in (`result.id`, `req.id?`) |
| errors via callback / boolean | typed `SteemAuthError` with codes (session) or `error` + `errorCode` state (hook) |
| — | verified origin (`src`) in every QR; durable revocation; off-chain login |

## Porting in three steps

```ts
// 1. Keychain
window.steem_keychain.requestTransfer(account, to, amount, memo, (r) => {
  r.success ? done(r.data.txId) : fail(r.error);
});

// 2. This package — same names, promise style
const auth = await createQrSession({ appName: "My dApp" });
const { account } = await auth.session.waitForAccount();
const r = await auth.session.transfer(to, amount, memo);   // auto-account!
r.success ? done(r.data?.txId) : fail(r.error);

// 3. Or keep your exact request objects:
const r2 = await auth.session.request(requestTransfer(account, to, amount, memo));
```

Notes when porting:

- **Callbacks → promises**: wrap in try/catch only for local failures
  (timeout/invalid/revoked) — user rejections resolve normally with
  `success: false`.
- **QR required**: every session needs one phone scan (5 min); after that,
  actions are as instant as Keychain — sequence freely within the session.
- **Account arguments**: account-defaulted actions drop the account
  parameter entirely (it's the *connected* one); raw `request()` still takes
  any `username`, validated against the connected account.
- **Weight & amounts** keep Keychain semantics (percent; asset strings with
  exact 3-decimal formatting).

## Result shape (compatible fields)

```ts
{
  id: string;
  success: boolean;
  method?: string;
  account?: string;
  data?: { txId?: string; signature?: string; [k: string]: unknown };
  error?: string;
  message?: string;
}
```
