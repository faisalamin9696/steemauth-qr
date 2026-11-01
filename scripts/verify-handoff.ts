/**
 * In-app handoff contract (src/handoff.ts):
 *   1. bridge  — inside the authenticator's WebView: postMessage wins,
 *                the message shape is exactly { t: HANDOFF_TYPE, c: payload }.
 *   2. scheme  — external touch browsers: steemauth://scan?payload=… href.
 *   3. none    — desktop / no window: nothing to hand off to (show the QR).
 */
import { HANDOFF_TYPE, handoffToSteemAuthenticator, isInSteemAuthenticator } from '../src/handoff';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

type GlobalWithWindow = typeof globalThis & {
  window?: unknown;
  navigator?: { userAgent: string };
};

const g = globalThis as GlobalWithWindow;

// ---- 1. no window at all (Node) -------------------------------------------
check('node (no window) returns none', handoffToSteemAuthenticator('{"v":2}') === 'none');

// ---- 2. bridge (inside the app's WebView) ---------------------------------
const posted: string[] = [];
g.window = {
  ReactNativeWebView: { postMessage: (m: string) => posted.push(m) },
} as unknown as Window & typeof globalThis;
check('bridge preferred when ReactNativeWebView is present', handoffToSteemAuthenticator('{"v":2}') === 'bridge');
check('isInSteemAuthenticator detects the bridge', isInSteemAuthenticator() === true);
let shape = false;
if (posted.length === 1) {
  try {
    const m = JSON.parse(posted[0]);
    shape = m.t === HANDOFF_TYPE && m.c === '{"v":2}';
  } catch {
    shape = false;
  }
}
check('message shape is { t: HANDOFF_TYPE, c: payload }', shape, posted);

// ---- 3. scheme (external touch browser) -----------------------------------
const fakeWindow: { location?: { href?: string } } = { location: {} };
g.window = fakeWindow as unknown as Window & typeof globalThis; // real browsers always have location — the mock needs it too
// Node ≥21 exposes `navigator` as a getter-only global — override it.
Object.defineProperty(g, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' },
  configurable: true,
});
check('scheme fallback on touch browsers', handoffToSteemAuthenticator('PAY') === 'scheme');
check(
  'scheme href carries the encoded payload',
  typeof fakeWindow.location?.href === 'string' && fakeWindow.location.href.startsWith('steemauth://scan?payload='),
  fakeWindow.location,
);

// ---- 4. desktop ------------------------------------------------------------
Object.defineProperty(g, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari' },
  configurable: true,
});
check('desktop returns none', handoffToSteemAuthenticator('PAY') === 'none');

console.log(`\nhandoff contract: ${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
