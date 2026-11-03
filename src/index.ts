/**
 * @steempro/steemauth-qr — generate SteemAuthenticator QR sessions and
 * request Steem actions (SteemKeychain-style) from the browser.
 *
 * The mobile app validates and broadcasts; keys never leave the device.
 */

// Session + transport
export {
  SteemAuthSession,
  type SteemAuthSessionOptions,
  type SessionStorageLike,
} from './session';

// Relay plane (protocol v3 — the only session transport)
export {
  createRelayPlane,
  MAX_ENVELOPE_BYTES,
  type MessagePlane,
  type MessagePlaneFactory,
  type RelayPlaneOptions,
  type RelayPlaneStatus,
} from './relay-plane';

// Registry-backed revocation watch (Supabase lives only in the relay)
export {
  watchRevocation,
  type RevocationWatch,
  type RevocationWatchOptions,
} from './revocation';

// Typed errors — branch on `code` instead of message strings
export {
  SteemAuthError,
  isSteemAuthError,
  type SteemAuthErrorCode,
} from './errors';

// Account-defaulted actions — the shared registry behind session.*,
// controller.* and the hook's actions
export {
  ACTIONS,
  buildAction,
  type ActionArgs,
  type ActionBuilders,
  type ActionName,
  type BatchInput,
  type ClaimRewardsParams,
  type PostParams,
} from './actions';

// Reactive state machine (framework-agnostic — what the React hook wraps)
export {
  SteemAuthController,
  type ControllerOptions,
  type QrRender,
  type SteemAuthState,
} from './controller';

// Ready-to-use entry point: QR → phone → result in ONE call
export {
  steemAuth,
  type SteemAuthOptions,
  type SteemAuthResult,
} from './steemAuth';

// All-in-one: session + rendered QR in one call
export {
  createQrSession,
  type CreateQrSessionOptions,
  type QrSession,
} from './qr-session';

// Protocol primitives (for advanced / DIY integrations)
export {
  DEFAULT_RELAY_URL,
  DEFAULT_SESSION_TTL_MS,
  PAYLOAD_TYPE,
  PROTOCOL_VERSION,
  ProtocolError,
  ROOM_RE,
  TOKEN_RE,
  createQrPayload,
  decryptMessage,
  encryptMessage,
  generateRoom,
  generateSessionId,
  generateSessionKey,
  generateToken,
  hmacHex,
  openMessage,
  parseQrPayload,
  sealMessage,
  serializeQrPayload,
  sha256Hex,
  type SealedEnvelope,
} from './protocol';

// QR rendering (built-in — any QR library also works with session.qrString)
export { toQrCanvas, toQrDataUrl, toQrSvg, type QrRenderOptions } from './qr';

// Keychain-style request builders
export {
  requestBatch,
  requestBroadcast,
  requestClaimRewards,
  requestCustomJson,
  requestDelegation,
  requestPost,
  requestPowerDown,
  requestPowerUp,
  requestProxy,
  requestSignBuffer,
  requestTransfer,
  requestVote,
  requestWitnessVote,
} from './requests';

// In-app handoff (browser bridge + external scheme fallback)
export {
  HANDOFF_TYPE,
  handoffToSteemAuthenticator,
  isInSteemAuthenticator,
  isTouchBrowser,
  type HandoffResult,
} from './handoff';

// Operation validation (mirrors the mobile app's rules)
export {
  MAX_OPERATIONS_PER_REQUEST,
  SUPPORTED_OPERATIONS,
  batchAuthority,
  getRequiredAuthority,
  referencedAccounts,
  validateOperations,
  type OperationsValidation,
} from './operations';

// Types
export type {
  AuthenticateOptions,
  AuthenticateResult,
  ConnectionStatus,
  CreateSessionOptions,
  KeyType,
  KeychainRequest,
  KeychainResult,
  Operation,
  SessionMessage,
  SignRequest,
  SessionQrPayload,
} from './types';
