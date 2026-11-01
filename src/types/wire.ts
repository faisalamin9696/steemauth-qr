/**
 * Wire types — the QR payload and the realtime message shapes. These must
 * stay byte-compatible with the mobile app:
 *   SteemAuthenticator/src/lib/protocol.ts  (source of truth)
 *   SteemAuthenticator/PROTOCOL.md          (human-readable spec)
 */

/** The QR payload the mobile app scans (protocol v3 — relay plane). */
export interface SessionQrPayload {
  /** protocol version — 3 (v1/v2 payloads are refused on both sides) */
  v: number;
  /** payload type — always "steem.session" */
  t: string;
  /** unique session id (uuid, >= 8 chars) */
  sid: string;
  /** requesting application name (shown on the phone) */
  app: string;
  /** requesting application origin (informational, developer-declared) */
  url: string;
  /**
   * **Verified source origin** — the page that generated this QR, captured
   * AUTOMATICALLY from `window.location.origin`. Deliberately not an option:
   * browsers mark `Location` unforgeable, so page code cannot spoof it, and
   * the phone displays it as the app's real URL. Absent outside browsers
   * (SSR / Node).
   */
  src?: string;
  /** target chain — only "steem" is accepted */
  chain: string;
  /**
   * Relay plane URL (ws(s)://) BOTH sides join. Defaults to the shared
   * public relay; self-hosters embed their own. Never a credential — the
   * same URL is already public in every QR.
   */
  rt: string;
  /**
   * Unguessable room name (~176 bits) — the relay's per-session stream.
   * The relay stores only token HASHES for it; possession of the QR (this
   * room + `tk` + `k`) is the capability, exactly as before.
   */
  rm: string;
  /**
   * The PHONE's room token. The app's own token never appears here — the
   * relay knows only sha256 hashes of both, and only the app token may
   * rotate the phone token or close the room.
   */
  tk: string;
  /** base64 AES key shared by both sides (32 bytes) */
  k: string;
  /** issued-at, ms epoch */
  ts: number;
  /** expiry, ms epoch — mobile refuses expired codes */
  exp: number;
  /**
   * Target account (optional): the Steem username this session expects.
   * When present the phone auto-selects that account on connect, so requests
   * land on the right key without the user switching accounts by hand.
   * Login QRs omit it (the account is what the scan establishes).
   */
  account?: string;
}

/** A Steem operation as [name, params] — same shape the chain serializes. */
export type Operation = [string, Record<string, unknown>];

/** SteemKeychain key types. */
export type KeyType = 'Posting' | 'Active' | 'Owner' | 'Memo';

/**
 * Off-chain signing payload.
 *
 * When present, the request asks the phone to sign `data` with the account's
 * key and return the compact signature — there is nothing to broadcast and
 * nothing touches the chain. This is what a Keychain-style `requestSignBuffer`
 * login needs: the app proves key possession by signing a challenge the
 * requesting site generated, without the key ever leaving the device.
 *
 * `data` is shown on the phone exactly as sent, so an integrator must never
 * put anything in it they would not want the user to read.
 */
export interface SignRequest {
  /** the exact UTF-8 text to sign */
  data: string;
  /** key to sign with — Posting for login, Active for privileged proofs */
  keyType?: KeyType;
}

/** Realtime messages, AES-encrypted with `k`, in the relay room `rm`. */
export type SessionMessage =
  /**
   * mobile → app: session established, account selected. (v3: the relay
   * URL/room/token come from the QR's `rt`/`rm`/`tk`, so no transport
   * negotiation is needed - the handshake travels in the room.)
   */
  | {
      type: 'ready';
      sid: string;
      account: string;
      authority: string;
      device?: string;
    }
  /** app → mobile: please execute/sign this request */
  | {
      type: 'request';
      sid: string;
      id: string;
      ops: Operation[];
      /** off-chain signing request — when set, `ops` is empty */
      sign?: SignRequest;
      action?: string;
      meta?: { description?: string; page?: string };
      /** ms timestamp after which the request is void */
      exp?: number;
    }
  /** mobile → app: result of a request */
  | {
      type: 'result';
      sid: string;
      id: string;
      ok: boolean;
      txId?: string;
      error?: string;
      account?: string;
      /** returned when the request only needed an off-chain signature */
      signature?: string;
    }
  /** either side: abandon a pending request */
  | { type: 'cancel'; sid: string; id: string; reason?: string }
  /**
   * mobile → app: the user revoked this app from the authenticator.
   * The whole session is over — tear down the SteemAuthSession and stop
   * sending requests. Distinct from `cancel`, which only kills one request.
   */
  | { type: 'revoke'; sid: string; reason?: string }
  /** keepalive */
  | { type: 'ping'; sid: string }
  | { type: 'pong'; sid: string };
