# Errors — typed, with codes

Every failure the package raises is a **`SteemAuthError`** with a
machine-readable `code` and a human message (safe to display, asserted by
the test suite). Branch on the code, never on the string.

```ts
import { SteemAuthError, isSteemAuthError } from "@steempro/steemauth-qr";

try {
  await session.request(req);
} catch (e) {
  if (isSteemAuthError(e)) {
    switch (e.code) {
      case "session-expired": rebuildQr(); break;
      case "revoked":         rebuildSession(); break;
      case "timeout":         show("No answer — try again"); break;
      default:                show(e.message);
    }
  }
}
```

## Codes

| Code | Meaning | Typical message |
|---|---|---|
| `disposed` | session/controller disposed — no further use | `Session already disposed` |
| `revoked` | the user revoked this app — session over | `Access was revoked in the authenticator.` |
| `not-connected` | `connect()`/`start()` hasn't completed (or failed) | `Session not connected — call connect() first` |
| `no-account` | acting before the phone scanned | `No authenticator connected yet — wait for waitForAccount()…` |
| `session-expired` | the QR TTL passed | `Session expired — generate a fresh QR code` |
| `invalid-request` | failed validation **before sending** | `Request not sent — Unsupported operation: wormhole` |
| `timeout` | no answer from the phone in time | `Timed out waiting for the mobile app…` |
| `plane-timeout` | plane subscribe took too long | `Timed out joining the message plane…` |
| `plane-failed` | message plane failed (subscribe/insert) | `Message plane connection failed…` |

`isSteemAuthError(e)` works across bundle copies (checks shape, not
identity). The `cause` of wrapped errors is preserved on `e.cause`.

## Who throws vs who records

| Surface | Policy |
|---|---|
| `SteemAuthSession` | **throws** `SteemAuthError` for all local failures; user outcomes (approve/reject/cancel) resolve normally |
| `SteemAuthController` | **never throws** for actions — `state.error` + `state.errorCode`, resolves `null`. `start()` may reject *and* records |
| `useSteemAuth()` | same as the controller |

User outcomes are **not errors**: a rejection resolves
`{ success: false, error: "User rejected the request." }` — the user
decided, the transport worked.

## Validation messages (client-side, byte-identical to the phone)

| Message | Cause |
|---|---|
| `Request not sent — Request contains no operations` | empty batch |
| `Request not sent — Too many operations in one request (max 20)` | split the batch |
| `Request not sent — Invalid operation: expected [name, params]` | malformed tuple |
| `Request not sent — Unsupported operation: x` | not in the 48-op whitelist |
| `Request not sent — Operations do not involve @x` | batch doesn't reference the connected account |
| `Request not sent — a sign request cannot also carry operations` | sign xor ops |
| `Invalid amount "1.9999": at most 3 decimal places` | money is never silently rounded |

## Construction errors

| Message | Cause |
|---|---|
| `appName is required (it is shown on the phone)` | missing `appName` |
| `ttlMs must be at least 30 seconds` | TTL too short |
| `No secure random source (WebCrypto) available — use a browser or Node.js 22+` | ancient runtime |

## Next

- [Troubleshooting](troubleshooting.md) — symptom-first tables
- [Operations](operations.md) · [Security](security.md)
