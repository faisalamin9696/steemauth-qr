# QR codes

The QR is the whole credential: it carries the session id, the 32-byte AES
key, the relay URL and the expiry. The package renders it for you (built on
[`qrcode`](https://www.npmjs.com/package/qrcode)) — or hand `qrString` to
any QR library you like.

## Built-in rendering

| API | Output | Works in |
|---|---|---|
| `createQrSession(opts)` | SVG **and** PNG in one call, already connected | anywhere |
| `session.qrSvg(opts?)` | standalone SVG string | any (SSR-safe) |
| `session.qrDataUrl(opts?)` | `data:image/png;base64,…` | `<img src>`, React Native |
| `toQrCanvas(canvas, payload, opts?)` | draws onto an existing `<canvas>` | browser |
| `session.qrString` | raw JSON payload | feed to your own renderer |

```ts
const auth = await createQrSession({ appName: "My dApp", qr: {
  size: 320,                        // px (data-URL / canvas)
  margin: 4,                        // quiet zone, modules (default 4)
  errorCorrectionLevel: "H",        // use H when overlaying a logo
  dark: "#101828",                  // module color
  light: "#ffffff",                 // background
}});
document.querySelector("#qr")!.innerHTML = auth.svg;
```

```ts
// Canvas, e.g. inside a React ref
import { toQrCanvas } from "@steempro/steemauth-qr";
await toQrCanvas(canvasRef.current!, auth.qrString, { size: 320 });
```

Any third-party component works too — the content is just JSON:

```tsx
import QRCode from "qrcode.react";
<QRCode value={auth.qrString} level="M" />
```

## Refresh & expiry

- Codes live `ttlMs` (default **5 minutes**, min 30 s). The phone refuses
  expired codes with a "refresh it" message.
- `session.expiresAt` (or `auth.expiresAt`) is the ms epoch — count down,
  then build a **new** session (new `sid`, new key, new QR). There is no
  renewal: expiry is the point.
- The phone also refuses `ts` more than 60 s in the future — keep device
  clocks sane.

## What the phone shows

Beside the app name, the phone displays the **verified origin** (`src`):
the page that generated the QR, captured automatically from
`window.location.origin`.

- It is **not an option** — there is no API to set or override it.
- Browsers mark `window.location` `[Unforgeable]`, so page script cannot
  replace `origin` with a lie — a phishing page can only show its own real
  origin.
- Outside browsers (SSR/Node) the field is absent and the phone falls back
  to the informational `url` (the `origin` option).

```jsonc
{
  "v": 2, "t": "steem.session",
  "sid": "<uuid>",
  "app": "My dApp",
  "url": "https://your.app",       // declared (informational)
  "src": "https://your.app",       // verified — automatic, non-overridable
  "chain": "steem",
  "sup": { "url": "https://…", "key": "…" }, // plane endpoint (auto)
  "k": "<base64, 32 bytes>",
  "ts": 1712345678900, "exp": 1712345738900
}
```

## Size & scannability

The payload is ~230 bytes — any QR version encodes it. Practical rules:

- render ≥ 240 px on screen; keep the default margin (4 modules);
- use error correction `M` normally, `H` only if you overlay a logo;
- don't shrink the SVG with CSS below its module grid (blurry scaling is
  the #1 scan failure).

## Security notes

- Treat a live QR like a **one-time password on screen**: don't log or
  persist `qrString` / `payload.k`.
- Anyone who scans the QR *is* the session — that's the design; the 5-minute
  TTL bounds the exposure.
- `dispose()` when the flow ends: it tears down the message stream so the QR stops
  being answerable.

## Next

- [Sessions](sessions.md) — lifecycle around the QR
- [Protocol](protocol.md) — the exact wire format
