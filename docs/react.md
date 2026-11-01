# React & reactive state

Two layers, pick by preference:

- **`useSteemAuth(options)`** — the React hook: state + actions, zero
  boilerplate. (Subpath import; React ≥ 18, optional peer dependency.)
- **`SteemAuthController`** — the same state machine, framework-agnostic
  (`getState()` + `subscribe()`); what the hook wraps. Use it from Vue,
  Svelte, or anywhere.

## `useSteemAuth` — the whole flow in a component

```tsx
import { useSteemAuth } from "@steempro/steemauth-qr/react";

export function SteemPay({ to, amount }: { to: string; amount: string }) {
  const auth = useSteemAuth({ appName: "My dApp", origin: window.location.origin });
  const [txId, setTxId] = useState<string | null>(null);

  if (txId)    return <p>Done ✔ {txId}</p>;
  if (auth.error) return <p style={{ color: "red" }}>{auth.error}</p>;
  if (auth.ready) return <p>Approve on your phone…</p>;
  if (!auth.qr) return <Spinner />;

  return (
    <div>
      <div dangerouslySetInnerHTML={{ __html: auth.qr.svg }} />
      <button disabled={auth.requesting || auth.expired}
        onClick={async () => {
          const res = await auth.transfer(to, amount);      // auto-account
          if (res?.success) setTxId(res.data?.txId as string);
          else if (auth.expired) auth.refresh();            // fresh QR
        }}>
        {auth.requesting ? "Waiting…" : "Approve transfer"}
      </button>
    </div>
  );
}
```

Semantics:

- **auto-start on mount, dispose on unmount**; the session is recreated only
  when option *values* change (inline objects are safe — the hook keys on a
  serialized snapshot);
- **SSR-safe** — nothing runs on the server; the first client render shows
  `loading`;
- action helpers **never throw**: failures land in `error` (+ `errorCode`)
  and the promise resolves to `null`; user outcomes come back as a
  `KeychainResult`.

## State (all reactive)

| Field | Type | Meaning |
|---|---|---|
| `status` | `"connecting" \| "waiting" \| "ready" \| "failed" \| "revoked" \| "disconnected"` | lifecycle |
| `loading` | `boolean` | connecting **or** a request is in flight |
| `connecting` / `requesting` | `boolean` | the halves of `loading` |
| `ready` | `boolean` | phone scanned — actions available |
| `account` | `string \| null` | connected account |
| `qr` | `{ svg, dataUrl, qrString } \| null` | rendered QR (null until live) |
| `expired` | `boolean` | QR TTL passed — `refresh()` |
| `expiresAt` | `number \| null` | ms epoch |
| `error` | `string \| null` | last **local** failure (user rejections are in the result, not here) |
| `errorCode` | `SteemAuthErrorCode \| null` | machine-readable form of `error` |
| `disposed` | `boolean` | unmounted/torn down |

## Actions (hook ≡ controller ≡ session)

| | |
|---|---|
| `vote`, `transfer`, `post`, `customJson`, `broadcast` | everyday |
| `powerUp`, `powerDown`, `delegate`, `claimRewards` | staking |
| `witnessVote`, `setProxy` | governance |
| `batch(requests)` · `request(req)` | merged / raw requests |
| `signBuffer(data, keyType?)` · `authenticate(options?)` | off-chain signing / login |
| `action(name, ...args)` | generic typed form of any of the above |
| `refresh()` · `start()` · `dispose()` · `cancel(id?, reason?)` | lifecycle |
| `controller` | the underlying `SteemAuthController` (escape hatch) |

Every action auto-uses the **connected account** — you never pass a username
or touch `session.account!`.

## `SteemAuthController` — other frameworks

```ts
import { SteemAuthController } from "@steempro/steemauth-qr";

const auth = new SteemAuthController({ appName: "My dApp" });
const unsub = auth.subscribe(() => render(auth.getState()));  // immutable snapshots
auth.start();                                   // connect + render QR (never rejects:
                                                // failures land in state.error)

await auth.transfer("bob", "1.500");            // null → state.error / state.errorCode
auth.refresh();                                 // new session + QR
auth.dispose();
auth.session;                                   // the raw SteemAuthSession, or null
```

`getState()` returns **stable references between changes** (immutable
snapshots) — safe with React's `useSyncExternalStore` or any memoized
binding. Errors: `start()` may reject (mirrored into state); actions never
do.

## Performance notes

- one render per state transition (snapshots are cached and diffed);
- `subscribe` fires your callback **immediately** with the current state;
- the QR renders once per session — reuse `state.qr.svg` freely;
- dispose is synchronous; unmount never leaks sockets, timers or waiters.

## Next

- [Sessions](sessions.md) · [Operations](operations.md) · [Errors](errors.md)
