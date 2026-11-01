/**
 * createQrSession() — the all-in-one, zero-config entry point.
 *
 * One call resolves the plane endpoint (runtime discovery when none is
 * configured), builds the session, subscribes to the message plane and
 * renders the QR in both SVG and PNG forms — a single await:
 *
 *   const auth = await createQrSession({ appName: "My dApp" });
 *   document.querySelector("#qr")!.innerHTML = auth.svg;   // or auth.dataUrl
 *
 *   const { account } = await auth.session.waitForAccount();
 *   const result = await auth.session.request(requestTransfer(account, "bob", "1.000"));
 *   auth.dispose();
 *
 * If anything fails (no endpoint discoverable, plane unreachable, QR render
 * error) the session is disposed before the error propagates — no leaks.
 */
import { SteemAuthSession, type SteemAuthSessionOptions } from './session';
import { toQrDataUrl, toQrSvg, type QrRenderOptions } from './qr';

export interface CreateQrSessionOptions extends SteemAuthSessionOptions {
  /** Rendering options for the built-in SVG / PNG outputs. */
  qr?: QrRenderOptions;
  /** Skip the PNG data-URL render (SVG only — slightly faster). Default false. */
  skipDataUrl?: boolean;
}

/** A ready-to-display session: rendered QR + the live session handle. */
export interface QrSession {
  /** The live session (connected). Use it for requests / status / events. */
  session: SteemAuthSession;
  /** The JSON payload — encode it yourself with any QR library if you prefer. */
  qrString: string;
  /** The QR as a standalone SVG string — inject straight into the DOM. */
  svg: string;
  /** The QR as a PNG data URL (`data:image/png;base64,…`) — use in `<img>`. */
  dataUrl: string;
  /** ms epoch when this QR expires — refresh by creating a new session. */
  expiresAt: number;
  /** Tear down the message stream (call when the flow ends). */
  dispose(): void;
}

/**
 * Build a session and render its QR in one step. Resolves once the message
 * plane is live, so showing the QR immediately can never miss the phone's
 * `ready` row.
 */
export async function createQrSession(
  options: CreateQrSessionOptions,
): Promise<QrSession> {
  const { qr, skipDataUrl, ...sessionOptions } = options;
  const session = new SteemAuthSession(sessionOptions);
  try {
    await session.connect();
    const [svg, dataUrl] = await Promise.all([
      toQrSvg(session.qrString, qr),
      skipDataUrl
        ? Promise.resolve('')
        : toQrDataUrl(session.qrString, qr),
    ]);
    return {
      session,
      qrString: session.qrString,
      svg,
      dataUrl,
      expiresAt: session.expiresAt,
      dispose: () => session.dispose(),
    };
  } catch (e) {
    session.dispose();
    throw e;
  }
}
