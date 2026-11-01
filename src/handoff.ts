/**
 * In-app handoff: how a page that is ALREADY running inside the
 * SteemAuthenticator's own browser gives its session to the app — without
 * leaving the page, without an OS intent, and without any route transit
 * (which is what caused the white/flashing screens: Android never delivers
 * custom-scheme navigations to the WebView, so the link escaped as an OS
 * intent and bounced through a route).
 *
 * Two transports, chosen automatically:
 *
 *   1. BRIDGE (inside the app's browser): the WebView injects
 *      `window.ReactNativeWebView`, so we post ONE message —
 *      `{ t: "steemauth.handoff", c: <serializedQrPayload> }` — and the app
 *      connects in place: same process, same surface, zero navigation.
 *      The app runs the SAME `parseSessionQr` validation as a camera scan.
 *      Requires an app whose browser handles `onMessage` for this type (the
 *      built-in browser screen does).
 *
 *   2. SCHEME (external mobile browsers): `steemauth://scan?payload=…` — the
 *      OS routes it into the app's full-screen approval flow.
 *      Desktop: nothing to hand off to → `none` (show the QR instead).
 *
 * The payload inside either transport is the SAME serialized QR payload, so
 * every receiver validates it identically (expiry, clock skew, plane
 * endpoint, blocklist, target account).
 *
 * Developer note: this is the ONLY supported handoff contract — apps must
 * not invent other message types, and pages should call
 * `handoffToSteemAuthenticator(qrString)` rather than building URLs.
 */

/** The one message type the browser bridge accepts. */
export const HANDOFF_TYPE = 'steemauth.handoff';

interface RnwGlobal {
  ReactNativeWebView?: { postMessage?: (message: string) => void };
}

function rnwBridge(): RnwGlobal['ReactNativeWebView'] {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as RnwGlobal).ReactNativeWebView;
}

/** True when this page runs inside SteemAuthenticator's browser. */
export function isInSteemAuthenticator(): boolean {
  return typeof rnwBridge()?.postMessage === 'function';
}

/** Coarse touch-device check (the scheme only exists on phones/tablets). */
export function isTouchBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Which transport carried (or would carry) the handoff. */
export type HandoffResult = 'bridge' | 'scheme' | 'none';

/**
 * Hand the session (the serialized QR payload) to the authenticator.
 *
 * Returns which transport took it: `'none'` means no target exists (desktop)
 * and the caller should keep showing the QR.
 */
export function handoffToSteemAuthenticator(qrString: string): HandoffResult {
  if (typeof window === 'undefined') return 'none';
  const bridge = rnwBridge();
  if (typeof bridge?.postMessage === 'function') {
    bridge.postMessage(JSON.stringify({ t: HANDOFF_TYPE, c: qrString }));
    return 'bridge';
  }
  if (isTouchBrowser()) {
    window.location.href = `steemauth://scan?payload=${encodeURIComponent(qrString)}`;
    return 'scheme';
  }
  return 'none';
}
