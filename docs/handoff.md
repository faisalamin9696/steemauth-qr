# In-App Handoff

How a web page gives a SteemAuth session to the **SteemAuthenticator** app —
the one supported contract. Implemented once in `src/handoff.ts`, mirrored by
the app's browser screen, consumed by steempro-next's
`openInSteemAuthenticator`.

## Why two transports

Android never delivers custom-scheme navigations (`steemauth://`) to a
`react-native-webview` page: the link escapes as an OS intent and bounces
through a route, which flashes a screen on every transit. A page that is
**already running inside the app's own browser** does not need the OS at all —
the WebView injects `window.ReactNativeWebView`, so we post one message and
the app connects **in place**: same process, same surface, zero navigation.

The scheme stays for **external mobile browsers**, where routing through the
OS into the app's full-screen approval flow is exactly right.

## API

```ts
import { handoffToSteemAuthenticator } from "@steempro/steemauth-qr";

const transport = handoffToSteemAuthenticator(qrString);
// 'bridge' — posted to the app's WebView (in-app browser)
// 'scheme' — steemauth://scan?payload=… fired (external mobile browser)
// 'none'   — no target exists (desktop): keep showing the QR
```

Helpers:

- `isInSteemAuthenticator(): boolean` — true inside the app's browser
  (`window.ReactNativeWebView` present).
- `isTouchBrowser(): boolean` — coarse mobile/tablet UA check (the scheme
  only exists on phones/tablets; desktops should show the QR).

## The bridge message

`handoffToSteemAuthenticator` posts exactly:

```json
{ "t": "steemauth.handoff", "c": "<serializedQrPayload>" }
```

- `t` — the constant `HANDOFF_TYPE` (`"steemauth.handoff"`). The app accepts
  **only** this type; every other message a page posts is ignored.
- `c` — the same serialized QR payload a camera scan encodes (the QR's inner
  string). Both transports carry the identical payload, so the app validates
  it identically either way: protocol version, expiry, clock skew (±60s),
  relay URL/room/token, chain, blocklist, target account.

App-side mirror: `HANDOFF_TYPE` in the app's `src/lib/protocol.ts` (the app
keeps its own protocol constants and never imports this package). Any app
implementing the browser side must accept the same shape.

## Versioning

- ≥ **2.4.0**: handoff API exported (`handoffToSteemAuthenticator`,
  `HANDOFF_TYPE`, `isInSteemAuthenticator`, `isTouchBrowser`).
- App ≥ the browser screen with `onMessage` support: required for the
  `bridge` transport. Ship frontend and app together; older apps simply never
  see bridge messages (they would fall back to the scheme path only if the
  page fires it — this package prefers the bridge whenever it is present).

## Security model

Unchanged from camera scans: possession of the payload (sid + encryption key
`k`) is the only capability. Any page in the WebView could post a message, but
it could already fire the scheme — the app's `parseSessionQr` gates both
identically, and a payload that fails validation never connects.

## Test

`npm run test` includes `scripts/verify-handoff.ts`, which mocks the three
environments (WebView bridge present → `bridge` with the exact message shape;
touch browser → `scheme` href; desktop/Node → `none`).
