/**
 * `steemAuth()` — the ready-to-use entry point.
 *
 * One call = render a QR → wait for the phone → done. This is the API the
 * README leads with; everything else in the package (session, controller,
 * hook, request builders) exists for callers who need finer control.
 *
 *   import { steemAuth, requestTransfer } from "@steempro/steemauth-qr";
 *
 *   const r = await steemAuth({ appName: "My dApp", qr: "#qr",
 *                               request: requestTransfer("bob", "1.500") });
 *   r.success ? console.log("tx:", r.txId) : console.log(r.error);
 *
 * Three modes, chosen by the options:
 *   - `request` — the phone approves a transaction (use the request* builders)
 *   - `login`   — the phone signs the off-chain login challenge
 *   - neither   — just establish the connection and get the account
 *
 * The session is always disposed when the call settles: no cleanup for the
 * caller to remember. Failures reject with a typed `SteemAuthError`
 * (`timeout`, `revoked`, `session-expired`, …); a user rejection on the
 * phone RESOLVES with `success: false` + `error` (a normal outcome, not a
 * crash).
 */
import { createQrSession } from './qr-session';
import { handoffToSteemAuthenticator, isTouchBrowser } from './handoff';
import { SteemAuthError } from './errors';
import type {
  AuthenticateResult,
  KeychainRequest,
  KeychainResult,
} from './types';
import type { SteemAuthSession, SteemAuthSessionOptions } from './session';

export interface SteemAuthOptions {
  /** App name shown on the phone (required). */
  appName: string;
  /**
   * Where to render the QR while waiting: a CSS selector (`"#qr"`) or an
   * element. The SVG is injected as its `innerHTML`.
   */
  qr?: string | Element;
  /** Receives the QR SVG (for React state, custom rendering, …). */
  onQr?: (svg: string) => void;
  /** Declared origin — defaults to `window.location.origin` in browsers. */
  origin?: string;
  /** QR lifetime in ms (default 5 minutes). */
  ttlMs?: number;
  /** Login mode: sign the off-chain challenge instead of broadcasting. */
  login?: boolean;
  /** Custom statement for the login challenge (login mode only). */
  statement?: string;
  /** The transaction to approve — build it with `requestVote`, `requestTransfer`, … */
  request?: KeychainRequest;
  /** Also open the phone app via intent/deep-link on touch devices. */
  handoff?: boolean;
  /** Called with the live session right after creation (status listeners, tests). */
  onSession?: (session: SteemAuthSession) => void;
  /** Advanced passthrough: `relayUrl`, `planeFactory` (tests), timeouts, storage. */
  session?: Partial<SteemAuthSessionOptions>;
}

export interface SteemAuthResult {
  /** Did the phone approve? Always `true` in connect-only mode. */
  success: boolean;
  /** Connected account (null only on failure). */
  account: string | null;
  /** Broadcast transaction id (request mode). */
  txId?: string;
  /** Rejection reason, when `success` is false. */
  error?: string;
  /** Login mode: the exact signed challenge text. */
  message?: string;
  /** Login mode: the compact signature (hex, 65 bytes). */
  signature?: string;
  /** Login mode: echo it back to your backend for replay protection. */
  nonce?: string;
  /** Login mode: when the challenge expires (ms epoch). */
  expiresAt?: number;
}

/** One call: QR → phone → result. See the module docs above. */
export async function steemAuth(
  options: SteemAuthOptions,
): Promise<SteemAuthResult> {
  const { appName, qr, onQr, login, request, statement, handoff, onSession, session } =
    options;

  if (login && request) {
    throw new SteemAuthError(
      'invalid-request',
      'Pass either login or request — not both',
    );
  }

  const auth = await createQrSession({
    appName,
    origin: options.origin,
    ttlMs: options.ttlMs,
    ...session,
  });

  try {
    onSession?.(auth.session);
    onQr?.(auth.svg);
    if (qr) {
      if (typeof document === 'undefined') {
        throw new SteemAuthError(
          'invalid-request',
          '`qr` needs a browser document — use `onQr` on the server',
        );
      }
      const el = typeof qr === 'string' ? document.querySelector(qr) : qr;
      if (!el) {
        throw new SteemAuthError(
          'invalid-request',
          `QR target not found: ${String(qr)}`,
        );
      }
      el.innerHTML = auth.svg;
    }
    if (handoff && isTouchBrowser()) {
      handoffToSteemAuthenticator(auth.qrString);
    }

    const { account } = await auth.session.waitForAccount();

    // Connect-only mode: the account IS the result.
    if (!login && !request) {
      return { success: true, account };
    }

    const result: AuthenticateResult | KeychainResult = login
      ? await auth.session.authenticate(statement ? { statement } : {})
      : await auth.session.request(request!);

    return {
      success: result.success,
      account: result.account ?? account,
      txId: (result as KeychainResult).data?.txId,
      error: result.error,
      message: (result as AuthenticateResult).message,
      signature: (result as AuthenticateResult).signature,
      nonce: (result as AuthenticateResult).nonce,
      expiresAt: (result as AuthenticateResult).expiresAt,
    };
  } finally {
    // Always dispose: the QR is done either way — nothing leaks on rejection,
    // timeout or a phone-side revoke.
    auth.dispose();
  }
}
