/**
 * Cross-check this package against the mobile app's implementation.
 *
 * The mobile app lives in ../SteemAuthenticator — its src/lib/protocol.ts
 * and src/lib/steem/decoder.ts are imported directly (they are pure TS,
 * no React Native dependencies), so any protocol drift fails this test.
 *
 * Run: npm test
 */
import {
  createQrPayload,
  encryptMessage,
  decryptMessage,
  openMessage,
  sealMessage,
  ROOM_RE,
  TOKEN_RE,
  serializeQrPayload,
  parseQrPayload,
} from '../src/protocol';
import type { SessionMessage } from '../src/types';
import {
  requestBroadcast,
  requestBatch,
  requestVote,
  requestSignBuffer,
  requestTransfer,
  requestPost,
  requestCustomJson,
  requestPowerUp,
  requestPowerDown,
  requestDelegation,
  requestClaimRewards,
  requestWitnessVote,
  requestProxy,
} from '../src/requests';
import {
  SUPPORTED_OPERATIONS,
  validateOperations,
} from '../src/operations';
import { toQrDataUrl, toQrSvg } from '../src/qr';
import { SteemAuthSession } from '../src/session';
import { DEFAULT_RELAY_URL } from '../src/protocol';

// Mobile app's implementations (pure TS, platform-independent).
import { mobile } from './mobile';

// The app's protocol implementation (pure TS) — resolved live from the
// checkout via scripts/mobile.ts (STEEMAUTHENTICATOR_DIR / ../../sa / sibling).
const {
  parseSessionQr,
  encryptMessage: mobileEncrypt,
  decryptMessage: mobileDecrypt,
  openMessage: mobileOpen,
  sealMessage: mobileSeal,
  ROOM_RE: mobileRoomRe,
  TOKEN_RE: mobileTokenRe,
} = mobile.protocol;
const { validateOperationBatch } = mobile.decoder;
const { SUPPORTED_OPERATIONS: MOBILE_SUPPORTED_OPERATIONS } = mobile.serializer;

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('      ', JSON.stringify(extra));
  }
}

// ---------------------------------------------------------------------------
// 1. QR payload: package → mobile parse
// ---------------------------------------------------------------------------
const payload = createQrPayload({
  appName: 'SteemPro',
  origin: 'https://steempro.com',
  ttlMs: 5 * 60 * 1000,
});
check(
  'QR payload embeds the v3 rendezvous fields (rt/rm/tk)',
  /^wss?:\/\//.test(payload.rt) && ROOM_RE.test(payload.rm) && TOKEN_RE.test(payload.tk),
  { rt: payload.rt, rm: payload.rm.slice(0, 10) + '…' },
);
check(
  'room and token are unique per payload (fresh randomness)',
  createQrPayload({ appName: 'SteemPro' }).rm !== payload.rm,
);

let mobileParsed: unknown;
try {
  mobileParsed = parseSessionQr(serializeQrPayload(payload));
} catch (e) {
  mobileParsed = e instanceof Error ? e.message : String(e);
}
check(
  'mobile parseSessionQr accepts package QR payload',
  typeof mobileParsed === 'object' && (mobileParsed as { sid?: string }).sid === payload.sid,
  mobileParsed,
);

// Round-trip through the package's own parser too.
const selfParsed = parseQrPayload(serializeQrPayload(payload));
check('package parseQrPayload round-trip', selfParsed.sid === payload.sid && selfParsed.k === payload.k);

// Expired payload must be rejected by BOTH sides.
const expired = { ...payload, exp: Date.now() - 1000 };
let mobileRejected = false;
try {
  parseSessionQr(JSON.stringify(expired));
} catch {
  mobileRejected = true;
}
let packageRejected = false;
try {
  parseQrPayload(JSON.stringify(expired));
} catch {
  packageRejected = true;
}
check('expired payload rejected by mobile', mobileRejected);
check('expired payload rejected by package', packageRejected);

// Room/token format gates match between the two implementations.
check(
  'room/token format gates match between package and mobile',
  ROOM_RE.source === mobileRoomRe.source && TOKEN_RE.source === mobileTokenRe.source,
  { pkg: ROOM_RE.source, mobile: mobileRoomRe.source },
);

// ---------------------------------------------------------------------------
// 1b. Parser parity: same normalized output, same rejections
// ---------------------------------------------------------------------------
const now = Date.now();
const pkgNormalized = parseQrPayload(serializeQrPayload(payload), now);
const mobileNormalized = parseSessionQr(serializeQrPayload(payload), { now });
check(
  'package parseQrPayload output equals mobile parseSessionQr output',
  JSON.stringify(pkgNormalized) === JSON.stringify(mobileNormalized),
  { pkg: pkgNormalized, mobile: mobileNormalized },
);

type QrMutation =
  | { raw: string }
  | { mutate: (p: Record<string, unknown>) => Record<string, unknown> };

const rejectionCases: Array<[string, QrMutation]> = [
  ['wrong protocol version', { mutate: (p) => ({ ...p, v: 4 }) }],
  ['wrong payload type', { mutate: (p) => ({ ...p, t: 'steem.other' }) }],
  ['short session id', { mutate: (p) => ({ ...p, sid: 'abc' }) }],
  ['short encryption key', { mutate: (p) => ({ ...p, k: 'abc' }) }],
  ['expired payload', { mutate: (p) => ({ ...p, exp: now - 1000 }) }],
  ['timestamp 61s in the future', { mutate: (p) => ({ ...p, ts: now + 61_000 }) }],
  ['wrong chain', { mutate: (p) => ({ ...p, chain: 'hive' }) }],
  ['invalid relay scheme', { mutate: (p) => ({ ...p, rt: 'ftp://relay.example' }) }],
  ['invalid room name', { mutate: (p) => ({ ...p, rm: 'not-a-room' }) }],
  ['invalid room token', { mutate: (p) => ({ ...p, tk: 'short' }) }],
  ['invalid app url scheme', { mutate: (p) => ({ ...p, src: 'ftp://evil.example' }) }],
  ['non-string app url', { mutate: (p) => ({ ...p, src: 42 }) }],
  ['not JSON', { raw: 'definitely-not-a-qr' }],
];

for (const [name, spec] of rejectionCases) {
  const raw = 'raw' in spec ? spec.raw : JSON.stringify(spec.mutate({ ...payload }));
  let pkgRejected = false;
  let mobileRejected = false;
  try {
    parseQrPayload(raw, now);
  } catch {
    pkgRejected = true;
  }
  try {
    parseSessionQr(raw, { now });
  } catch {
    mobileRejected = true;
  }
  check(`both parsers reject: ${name}`, pkgRejected && mobileRejected, {
    pkgRejected,
    mobileRejected,
  });
}

// Boundary: timestamp 59s in the future is allowed by BOTH (60s skew guard).
const skewed = { ...payload, ts: now + 59_000 };
let pkgAllowed = true;
let mobileAllowed = true;
try {
  parseQrPayload(JSON.stringify(skewed), now);
} catch {
  pkgAllowed = false;
}
try {
  parseSessionQr(JSON.stringify(skewed), { now });
} catch {
  mobileAllowed = false;
}
check('both parsers allow 59s clock skew', pkgAllowed && mobileAllowed);

// ---------------------------------------------------------------------------
// 1c. Zero-config rendezvous (rt/rm/tk) + v1/v2 QRs refused by BOTH sides
// ---------------------------------------------------------------------------
const zero = createQrPayload({ appName: 'ZeroConfig' });
check(
  'zero-config QR embeds the default relay (rt)',
  zero.rt === DEFAULT_RELAY_URL,
  zero.rt,
);
check(
  'room + phone token are generated in the valid format',
  ROOM_RE.test(zero.rm) && TOKEN_RE.test(zero.tk) && zero.rm !== payload.rm,
  { rm: zero.rm.slice(0, 10) + '…' },
);
let zeroAcceptedByMobile = false;
try {
  zeroAcceptedByMobile = parseSessionQr(serializeQrPayload(zero)).sid === zero.sid;
} catch {
  zeroAcceptedByMobile = false;
}
check('mobile accepts the zero-config QR payload', zeroAcceptedByMobile);
check(
  'default relay is TLS (wss://)',
  DEFAULT_RELAY_URL.startsWith('wss://'),
  DEFAULT_RELAY_URL,
);

// v1 (relay-era: rt, no rm/tk) and v2 (supabase-era: sup, no rm/tk) QRs are
// refused by version on BOTH sides — old peers fail cleanly, never hang.
const v1Qr = { ...payload, v: 1, rm: undefined, tk: undefined, rt: 'wss://legacy-relay.example' };
let pkgRejectedV1 = false;
let mobileRejectedV1 = false;
try {
  parseQrPayload(JSON.stringify(v1Qr));
} catch (e) {
  pkgRejectedV1 = (e as Error).message.includes('Unsupported protocol version: 1');
}
try {
  parseSessionQr(JSON.stringify(v1Qr));
} catch (e) {
  mobileRejectedV1 = (e as Error).message.includes('Unsupported protocol version: 1');
}
check('package refuses v1 (relay) QR payloads by version', pkgRejectedV1);
check('mobile refuses v1 (relay) QR payloads by version', mobileRejectedV1);

const v2Qr = {
  ...payload,
  v: 2,
  rm: undefined,
  tk: undefined,
  sup: { url: 'https://plane.supabase.co', key: 'anon' },
};
let pkgRejectedV2 = false;
let mobileRejectedV2 = false;
try {
  parseQrPayload(JSON.stringify(v2Qr));
} catch (e) {
  pkgRejectedV2 = (e as Error).message.includes('Unsupported protocol version: 2');
}
try {
  parseSessionQr(JSON.stringify(v2Qr));
} catch (e) {
  mobileRejectedV2 = (e as Error).message.includes('Unsupported protocol version: 2');
}
check('package refuses v2 (supabase) QR payloads by version', pkgRejectedV2);
check('mobile refuses v2 (supabase) QR payloads by version', mobileRejectedV2);

// A v3 payload missing its rendezvous fields is refused by both parsers.
const noRm = { ...payload } as Record<string, unknown>;
delete noRm.rm;
let pkgRejectedNoRm = false;
let mobileRejectedNoRm = false;
try {
  parseQrPayload(JSON.stringify(noRm));
} catch (e) {
  pkgRejectedNoRm = (e as Error).message.includes('room name');
}
try {
  parseSessionQr(JSON.stringify(noRm));
} catch (e) {
  mobileRejectedNoRm = (e as Error).message.includes('room name');
}
check('both parsers refuse a v3 QR without rm', pkgRejectedNoRm && mobileRejectedNoRm, {
  pkg: pkgRejectedNoRm, mobile: mobileRejectedNoRm,
});

// ---------------------------------------------------------------------------
// 1d. Verified source origin (`src`) — automatic and non-overridable
// ---------------------------------------------------------------------------
const g = globalThis as { location?: { origin: unknown } };
const hadLocation = 'location' in g;
const prevLocation = g.location;
try {
  g.location = { origin: 'https://demo.example.com' };
  const withSrc = createQrPayload({ appName: 'Demo' });
  check(
    'QR auto-carries the page origin as src',
    withSrc.src === 'https://demo.example.com',
    withSrc.src,
  );

  const spoofAttempt = createQrPayload({
    appName: 'Demo',
    origin: 'https://claimed.example',
    src: 'https://evil.example',
  } as never);
  check(
    'src cannot be overridden through options (origin only fills url)',
    spoofAttempt.src === 'https://demo.example.com' &&
      spoofAttempt.url === 'https://claimed.example',
    { src: spoofAttempt.src, url: spoofAttempt.url },
  );

  const serialized = serializeQrPayload(withSrc);
  const pkgNorm = parseQrPayload(serialized, now);
  const mobileNorm = parseSessionQr(serialized, { now });
  check(
    'both parsers normalize a src-carrying payload identically',
    JSON.stringify(pkgNorm) === JSON.stringify(mobileNorm),
    { pkg: pkgNorm, mobile: mobileNorm },
  );
  check(
    'mobile accepts the auto-captured origin',
    mobileNorm.src === 'https://demo.example.com',
    mobileNorm.src,
  );

  g.location = { origin: 'not-an-origin' };
  check(
    'malformed page origins are not captured as verified src',
    createQrPayload({ appName: 'Demo' }).src === undefined,
  );
} finally {
  if (hadLocation) g.location = prevLocation;
  else delete g.location;
}
check(
  'no window.location (Node/SSR) → src absent from the QR',
  createQrPayload({ appName: 'Node' }).src === undefined,
);

// ---------------------------------------------------------------------------
// 2. Message encryption: both directions, both implementations
// ---------------------------------------------------------------------------
const requestMessage = {
  type: 'request' as const,
  sid: payload.sid,
  id: 'req-test-1',
  ops: requestVote('alice', 'bob', 'hello-world', 100).operations,
  action: 'requestVote',
  meta: { description: 'requestVote', page: 'https://steempro.com/post/1' },
  exp: payload.exp,
};

const pkgCipher = encryptMessage(requestMessage, payload.k);
const decryptedByMobile = mobileDecrypt(pkgCipher, payload.k);
check(
  'package encrypt → mobile decrypt',
  JSON.stringify(decryptedByMobile) === JSON.stringify(requestMessage),
  decryptedByMobile,
);

const mobileCipher = mobileEncrypt(
  {
    type: 'result',
    sid: payload.sid,
    id: 'req-test-1',
    ok: true,
    txId: 'abc123',
  } as never,
  payload.k,
);
const decryptedByPkg = decryptMessage(mobileCipher, payload.k);
check(
  'mobile encrypt → package decrypt',
  (decryptedByPkg as { type: string; txId?: string }).type === 'result' &&
    (decryptedByPkg as { txId?: string }).txId === 'abc123',
  decryptedByPkg,
);

// Wrong key must fail on both sides.
let mobileBadKeyFailed = false;
try {
  mobileDecrypt(pkgCipher, 'not-the-right-key');
} catch {
  mobileBadKeyFailed = true;
}
check('mobile rejects message encrypted with wrong key', mobileBadKeyFailed);

// ---------------------------------------------------------------------------
// 2b. New v1.1 message shapes: `sign` on requests + `revoke`
// ---------------------------------------------------------------------------
const signRequestMessage = {
  type: 'request' as const,
  sid: payload.sid,
  id: 'req-sign-1',
  ops: [],
  sign: { data: 'SteemPro wants you to sign in with your Steem account:\nalice', keyType: 'Posting' as const },
  action: 'authenticate',
  exp: payload.exp,
};
const signCipher = encryptMessage(signRequestMessage, payload.k);
const signOnMobile = mobileDecrypt(signCipher, payload.k) as typeof signRequestMessage;
check(
  'request with sign field round-trips to the mobile implementation intact',
  signOnMobile.type === 'request' &&
    signOnMobile.sign?.data === signRequestMessage.sign.data &&
    signOnMobile.ops.length === 0 &&
    signOnMobile.action === 'authenticate',
  signOnMobile,
);

const revokeMessage = {
  type: 'revoke' as const,
  sid: payload.sid,
  reason: 'Access was revoked in the authenticator.',
};
const revokeCipher = encryptMessage(revokeMessage, payload.k);
const revokeOnMobile = mobileDecrypt(revokeCipher, payload.k) as typeof revokeMessage;
check(
  'revoke message round-trips to the mobile implementation intact',
  revokeOnMobile.type === 'revoke' &&
    revokeOnMobile.sid === payload.sid &&
    revokeOnMobile.reason === 'Access was revoked in the authenticator.',
  revokeOnMobile,
);
const revokeFromMobile = decryptMessage(
  mobileEncrypt(revokeMessage as never, payload.k),
  payload.k,
) as typeof revokeMessage;
check(
  'mobile-encrypted revoke decrypts on the package side',
  revokeFromMobile.type === 'revoke' && revokeFromMobile.reason === revokeMessage.reason,
  revokeFromMobile,
);

// Handshake parity: the v2 `ready` (plain — the endpoint comes from the QR,
// so there is no sup/mp negotiation anymore) survives both directions.
const readyMessage = {
  type: 'ready' as const,
  sid: payload.sid,
  account: 'alice',
  authority: 'posting',
  device: 'test-device',
};
const readyOnMobile = mobileDecrypt(
  encryptMessage(readyMessage, payload.k),
  payload.k,
) as typeof readyMessage;
check(
  'ready round-trips to the mobile implementation intact',
  readyOnMobile.type === 'ready' &&
    readyOnMobile.account === 'alice' &&
    readyOnMobile.device === 'test-device',
  readyOnMobile,
);
const readyBackPkg = decryptMessage(
  mobileEncrypt(readyMessage as never, payload.k),
  payload.k,
) as typeof readyMessage;
check(
  'mobile-encrypted ready decrypts on the package side',
  readyBackPkg.type === 'ready' && readyBackPkg.account === 'alice',
  readyBackPkg,
);

// ---------------------------------------------------------------------------
// 3. Request builders → operations validate on the mobile side
// ---------------------------------------------------------------------------
const builtRequests = [
  ['requestVote', requestVote('alice', 'bob', 'my-post', 50)],
  ['requestTransfer', requestTransfer('alice', 'bob', '1.5', 'hi')],
  [
    'requestPost',
    requestPost({ username: 'alice', title: 'T', body: 'B', permlink: 'p' }),
  ],
  [
    'requestCustomJson',
    requestCustomJson('alice', 'sm_follow', { follower: 'alice', following: 'bob' }),
  ],
  ['requestPowerUp', requestPowerUp('alice', '2.000')],
  ['requestPowerDown', requestPowerDown('alice', '10.000000 VESTS')],
  ['requestDelegation', requestDelegation('alice', 'bob', '1000.000000 VESTS')],
  [
    'requestClaimRewards',
    requestClaimRewards({
      username: 'alice',
      rewardSteem: '0.100 SBD',
      rewardSbd: '0.200 SBD',
      rewardVests: '1.000000 VESTS',
    }),
  ],
  [
    'requestBroadcast',
    requestBroadcast('alice', [
      ['vote', { voter: 'alice', author: 'bob', permlink: 'x', weight: 10000 }],
    ]),
  ],
] as const;

for (const [name, req] of builtRequests) {
  const validation = validateOperationBatch(req.operations, {
    expectedAccount: 'alice',
  });
  check(
    `mobile validates ${name} operations`,
    validation.ok,
    validation.ok ? undefined : validation.error,
  );
}

// Witness / proxy builders cover the remaining high-use operations.
const witnessRequests = [
  ['requestWitnessVote', requestWitnessVote('alice', 'good-guy')],
  ['requestWitnessVote (remove)', requestWitnessVote('alice', 'good-guy', false)],
  ['requestProxy', requestProxy('alice', 'steempro')],
  ['requestProxy (remove)', requestProxy('alice', '')],
] as const;
for (const [name, req] of witnessRequests) {
  const validation = validateOperationBatch(req.operations, {
    expectedAccount: 'alice',
  });
  check(
    `mobile validates ${name} operations`,
    validation.ok,
    validation.ok ? undefined : validation.error,
  );
}

// ---------------------------------------------------------------------------
// 3a. requestBatch — merge builder results into ONE phone approval
// ---------------------------------------------------------------------------
const merged = requestBatch('alice', [
  requestVote('alice', 'bob', 'post', 50),
  requestCustomJson('alice', 'sm_follow', { follower: 'alice', following: 'bob' }),
]);
check('requestBatch merges operations into one request', merged.operations.length === 2, merged.operations);
check(
  'mobile validates the merged batch',
  validateOperationBatch(merged.operations, { expectedAccount: 'alice' }).ok,
);
check('requestBatch derives Posting from its ops', merged.keyType === 'Posting');
check(
  'requestBatch description lists the merged methods',
  merged.description === 'requestVote + requestCustomJson',
  merged.description,
);
const activeBatch = requestBatch('alice', [
  requestVote('alice', 'bob', 'post', 50),
  requestTransfer('alice', 'bob', '1.000'),
]);
check('requestBatch escalates to Active when a transfer is included', activeBatch.keyType === 'Active');
check(
  'requestBatch rejects mixed accounts',
  threw(() =>
    requestBatch('alice', [
      requestVote('alice', 'bob', 'post', 50),
      requestTransfer('bob', 'carol', '1.000'),
    ]),
  ).includes('same account'),
);
check(
  'requestBatch enforces the 20-op limit across merged requests',
  threw(() =>
    requestBatch('alice', [
      requestBroadcast(
        'alice',
        Array.from({ length: 12 }, () => requestVote('alice', 'bob', 'x', 50).operations[0]!),
      ),
      requestBroadcast(
        'alice',
        Array.from({ length: 12 }, () => requestVote('alice', 'bob', 'y', 50).operations[0]!),
      ),
    ]),
  ).includes('Too many operations in one request (max 20)'),
);

// ---------------------------------------------------------------------------
// 3b. Operation whitelist parity: package list === mobile serializer list
// ---------------------------------------------------------------------------
check(
  'SUPPORTED_OPERATIONS matches the mobile serializer exactly',
  JSON.stringify(SUPPORTED_OPERATIONS) === JSON.stringify(MOBILE_SUPPORTED_OPERATIONS),
  {
    packageCount: SUPPORTED_OPERATIONS.length,
    mobileCount: MOBILE_SUPPORTED_OPERATIONS.length,
  },
);

// requestBroadcast fails fast at build time for doomed batches.
function threw(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
check(
  'requestBroadcast refuses unsupported operations at build time',
  threw(() => requestBroadcast('alice', [['wormhole', { a: 1 }]])).includes(
    'Unsupported operation: wormhole',
  ),
);
check(
  'requestBroadcast refuses batches over 20 ops at build time',
  threw(() =>
    requestBroadcast(
      'alice',
      Array.from({ length: 21 }, () => requestVote('alice', 'bob', 'x', 50).operations[0]!),
    ),
  ).includes('Too many operations in one request (max 20)'),
);

// ---------------------------------------------------------------------------
// 3c. validateOperations mirrors validateOperationBatch (ok / error / authority)
// ---------------------------------------------------------------------------
const voteOp: unknown[] = ['vote', { voter: 'alice', author: 'bob', permlink: 'x', weight: 500 }];
const parityBatches: Array<[string, unknown[]]> = [
  ['vote batch', [voteOp]],
  ['transfer batch', [['transfer', { from: 'alice', to: 'bob', amount: '1.000 STEEM', memo: '' }]]],
  ['posting custom_json', [['custom_json', { required_auths: [], required_posting_auths: ['alice'], id: 'sm', json: '{}' }]]],
  ['active custom_json', [['custom_json', { required_auths: ['alice'], required_posting_auths: [], id: 'sm', json: '{}' }]]],
  ['comment', [['comment', { parent_author: '', parent_permlink: 'steem', author: 'alice', permlink: 'p', title: 't', body: 'b', json_metadata: '{}' }]]],
  ['claim_reward_balance', [['claim_reward_balance', { account: 'alice', reward_steem: '0.000 STEEM', reward_sbd: '0.000 SBD', reward_vests: '0.000000 VESTS' }]]],
  ['account_update2 (posting)', [['account_update2', { account: 'alice', owner: null, active: null, posting: null, memo_key: 'STM...', json_metadata: '', extensions: [] }]]],
  ['account_update (active)', [['account_update', { account: 'alice', owner: null, active: null, posting: null, memo_key: 'STM...', json_metadata: '' }]]],
  ['withdraw_vesting (active)', [['withdraw_vesting', { account: 'alice', vesting_shares: '1.000000 VESTS' }]]],
  ['mixed batch needs active', [voteOp, ['transfer', { from: 'alice', to: 'bob', amount: '1.000 STEEM', memo: '' }]]],
];

for (const [name, ops] of parityBatches) {
  const pkg = validateOperations(ops, { expectedAccount: 'alice' });
  const mob = validateOperationBatch(ops, { expectedAccount: 'alice' });
  check(
    `validation parity: ${name}`,
    pkg.ok === mob.ok && pkg.authority === mob.authority,
    { package: pkg, mobile: { ok: mob.ok, authority: mob.authority, error: mob.error } },
  );
}

const invalidBatches: Array<[string, unknown[], string]> = [
  ['empty batch', [], 'Request contains no operations'],
  [
    'too many operations',
    Array.from({ length: 21 }, () => voteOp),
    'Too many operations in one request (max 20)',
  ],
  ['not a tuple', [['vote']], 'Invalid operation: expected [name, params]'],
  [
    'unsupported operation',
    [['wormhole', { account: 'alice' }]],
    'Unsupported operation: wormhole',
  ],
  [
    'batch without the connected account',
    [['transfer', { from: 'bob', to: 'carol', amount: '1.000 STEEM', memo: '' }]],
    'Operations do not involve @alice',
  ],
];

for (const [name, ops, expectedError] of invalidBatches) {
  const pkg = validateOperations(ops, { expectedAccount: 'alice' });
  const mob = validateOperationBatch(ops, { expectedAccount: 'alice' });
  check(
    `package rejects ${name} with the mobile app's wording`,
    !pkg.ok && !mob.ok && pkg.error === expectedError && mob.error === expectedError,
    { package: pkg.error, mobile: mob.error },
  );
}

// The package additionally refuses non-object params (the app would coerce
// them to an empty struct and only fail later — after the user approved).
const nonObjectParams = validateOperations([['vote', 'not-an-object']]);
const mobileWouldAccept = validateOperationBatch([['vote', 'not-an-object']]);
check(
  'package refuses non-object params before the mobile app sees them',
  !nonObjectParams.ok && mobileWouldAccept.ok,
  { package: nonObjectParams.error, mobileOk: mobileWouldAccept.ok },
);

// ---------------------------------------------------------------------------
// 4. Vote weight semantics (Keychain: 0-100 percent → chain: 0-10000)
// ---------------------------------------------------------------------------
const vote = requestVote('alice', 'bob', 'post', 100);
check(
  '100% vote serializes as weight 10000',
  (vote.operations[0]![1] as { weight: number }).weight === 10000,
);
const halfVote = requestVote('alice', 'bob', 'post', 25);
check(
  '25% vote serializes as weight 2500',
  (halfVote.operations[0]![1] as { weight: number }).weight === 2500,
);

// ---------------------------------------------------------------------------
// 5. Amount normalization (string-exact, never rounds, never float-mangles)
// ---------------------------------------------------------------------------
const t = requestTransfer('alice', 'bob', '0.5');
check(
  'bare amount gets STEEM symbol + 3 decimals',
  (t.operations[0]![1] as { amount: string }).amount === '0.500 STEEM',
  t.operations[0]![1],
);

const amountCases: Array<[string, string, string]> = [
  ['pads to 3 decimals', '5', '5.000 STEEM'],
  ['keeps explicit symbol', '1.234 SBD', '1.234 SBD'],
  ['uppercases symbol', '1.234 steem', '1.234 STEEM'],
  ['trailing zeros beyond 3 are kept-as-value', '1.234000', '1.234 STEEM'],
  ['large values stay exact (no float math)', '123456789012345678', '123456789012345678.000 STEEM'],
  ['zero', '0', '0.000 STEEM'],
];
for (const [name, input, expected] of amountCases) {
  const req = requestTransfer('alice', 'bob', input);
  const actual = (req.operations[0]![1] as { amount: string }).amount;
  check(`amount: ${name}`, actual === expected, { input, actual, expected });
}

const badAmounts = ['1.9999', 'abc', '1.2.3', '', '-1', '1e3'];
for (const bad of badAmounts) {
  let threw = false;
  try {
    requestTransfer('alice', 'bob', bad);
  } catch {
    threw = true;
  }
  check(`amount rejects ${JSON.stringify(bad)}`, threw);
}

// The historic bug this guards: 1.9999 STEEM must NOT silently round to 2.000.
let roundedSilently = false;
try {
  const r = requestTransfer('alice', 'bob', '1.9999');
  const a = (r.operations[0]![1] as { amount: string }).amount;
  roundedSilently = a === '2.000 STEEM';
} catch {
  // rejected — correct
}
check('1.9999 STEEM is refused instead of silently rounded', !roundedSilently);

// ---------------------------------------------------------------------------
// 6. Message from the package passes mobile batch validation end-to-end
// ---------------------------------------------------------------------------
const batchValidation = validateOperationBatch(requestMessage.ops as unknown[], {
  expectedAccount: 'alice',
});
check('end-to-end request message validates on mobile', batchValidation.ok, batchValidation.ok ? undefined : batchValidation.error);

// ---------------------------------------------------------------------------
// 7. Built-in QR rendering — all-in-one, no extra library needed
// ---------------------------------------------------------------------------
const svgOut = await toQrSvg(serializeQrPayload(payload));
check('toQrSvg renders a standalone SVG', svgOut.includes('<svg') && svgOut.includes('</svg>'));
check(
  'toQrSvg honors render options',
  (await toQrSvg(serializeQrPayload(payload), { dark: '#123456', margin: 6 })).includes('#123456'),
);
const pngOut = await toQrDataUrl(serializeQrPayload(payload));
check(
  'toQrDataUrl renders a PNG data URL',
  pngOut.startsWith('data:image/png;base64,') && pngOut.length > 1000,
);

// ---------------------------------------------------------------------------
// 8. Off-chain signing (requestSignBuffer) — additive, backwards compatible
// ---------------------------------------------------------------------------
const signReq = requestSignBuffer('alice', 'Login to SteemPro');
check('sign request carries no operations', signReq.operations.length === 0);
check('sign request names the method', signReq.method === 'requestSignBuffer');
check(
  'sign request carries the data and key type',
  signReq.sign?.data === 'Login to SteemPro' && signReq.sign?.keyType === 'Posting',
);

let emptyDataRefused = false;
try {
  requestSignBuffer('alice', '');
} catch {
  emptyDataRefused = true;
}
check('empty sign data is refused', emptyDataRefused);

let oversizedRefused = false;
try {
  requestSignBuffer('alice', 'x'.repeat(5000));
} catch {
  oversizedRefused = true;
}
check('oversized sign data is refused rather than flooding the phone', oversizedRefused);

// A request frame carrying `sign` must survive the app's own decryptor, which
// is loaded straight from the live app checkout (scripts/mobile.ts) rather
// than reimplemented.
const signFrame = {
  type: 'request',
  sid: payload.sid,
  id: 'sign-1',
  ops: [],
  sign: { data: 'Login to SteemPro', keyType: 'Posting' },
  action: 'requestSignBuffer',
  exp: payload.exp,
} as SessionMessage;
const decryptedSign = decryptMessage(encryptMessage(signFrame, payload.k), payload.k);
check(
  'the app decrypts a sign request intact',
  decryptedSign.type === 'request' &&
    decryptedSign.sign?.data === 'Login to SteemPro' &&
    decryptedSign.sign?.keyType === 'Posting',
);

// Existing broadcast frames carry no `sign`; they must still parse, since the
// field is optional and released app builds predate it.
const legacyFrame = {
  type: 'request',
  sid: payload.sid,
  id: 'legacy-1',
  ops: [],
  action: 'requestBroadcast',
  exp: payload.exp,
} as SessionMessage;
const decryptedLegacy = decryptMessage(encryptMessage(legacyFrame, payload.k), payload.k);
check(
  'a request without sign still round-trips (released apps keep working)',
  decryptedLegacy.type === 'request' && decryptedLegacy.sign === undefined,
);

// ---------------------------------------------------------------------------
// Targeted sessions: optional `account` names the account the QR is for. The
// phone auto-selects it on connect, so multi-account users never have to
// switch by hand. The field stays optional - QRs without it (released builds,
// login flows) must behave exactly as before.
// ---------------------------------------------------------------------------
const targeted = createQrPayload({
  appName: 'SteemPro',
  origin: 'https://steempro.com',
  ttlMs: 5 * 60 * 1000,
  account: '  Alice.Steem ', // whitespace + case: both parsers normalize
});
const targetedPkg = parseQrPayload(serializeQrPayload(targeted), now);
check(
  'target account survives creation and the package parser (normalized)',
  targetedPkg.account === 'alice.steem',
  targetedPkg.account,
);
const targetedMobile = parseSessionQr(serializeQrPayload(targeted), { now });
check(
  'mobile parseSessionQr agrees on the target account',
  targetedMobile.account === 'alice.steem',
  targetedMobile.account,
);
check(
  'targeted payload normalizes identically on both sides',
  JSON.stringify(targetedPkg) === JSON.stringify(targetedMobile),
);
check(
  'QRs without a target account keep working (field optional)',
  parseQrPayload(serializeQrPayload(payload), now).account === undefined &&
    parseSessionQr(serializeQrPayload(payload), { now }).account === undefined,
);
let refusedAtCreation = false;
try {
  createQrPayload({
    appName: 'SteemPro',
    account: 'not valid!!',
  });
} catch {
  refusedAtCreation = true;
}
check('malformed target account refused at creation', refusedAtCreation);
let refusedByPkg = false;
let refusedByMobile = false;
try {
  parseQrPayload(JSON.stringify({ ...payload, account: 'not valid!!' }), now);
} catch {
  refusedByPkg = true;
}
try {
  parseSessionQr(JSON.stringify({ ...payload, account: 'not valid!!' }), { now });
} catch {
  refusedByMobile = true;
}
check('malformed target account rejected by BOTH parsers', refusedByPkg && refusedByMobile);

// ---------------------------------------------------------------------------
// 8b. encrypt-then-MAC parity (v3) — both directions + tamper detection
// ---------------------------------------------------------------------------
const sealed = sealMessage(requestMessage, payload.k);
check(
  'package sealMessage produces { c, m } with a 64-hex tag',
  typeof sealed.c === 'string' && /^[0-9a-f]{64}$/.test(sealed.m),
);

const openedByMobile = mobileOpen(sealed, payload.k) as typeof requestMessage | null;
check(
  'mobile openMessage verifies + decrypts a package-sealed envelope',
  openedByMobile !== null && openedByMobile.sid === payload.sid && openedByMobile.type === requestMessage.type,
);

const sealedByMobile = mobileSeal(requestMessage as never, payload.k) as { c: string; m: string };
const openedByPkg = openMessage(sealedByMobile, payload.k);
check(
  'package openMessage verifies + decrypts a mobile-sealed envelope',
  openedByPkg !== null && openedByPkg.sid === payload.sid,
);

const flipChar = (str: string, i: number) =>
  str.slice(0, i) + (str[i] === 'A' ? 'B' : 'A') + str.slice(i + 1);
const tamperedC = { c: flipChar(sealed.c, 10), m: sealed.m };
check('tampered ciphertext is dropped by the mobile side', mobileOpen(tamperedC, payload.k) === null);
check('tampered ciphertext is dropped by the package side', openMessage(tamperedC, payload.k) === null);
const forgedTag = { c: sealed.c, m: 'f'.repeat(64) };
check('forged HMAC tag is dropped by the mobile side', mobileOpen(forgedTag, payload.k) === null);
check('forged HMAC tag is dropped by the package side', openMessage(forgedTag, payload.k) === null);

// Cross-session injection: an envelope sealed with ANOTHER session's key
// (what a malicious relay could replay from a different room) never opens.
const crossSealed = sealMessage(requestMessage, 'another-session-key-entirely');
check(
  'cross-session envelope is dropped by both sides',
  openMessage(crossSealed, payload.k) === null && mobileOpen(crossSealed, payload.k) === null,
);

// Shape gates: nothing reaches crypto without { c: string, m: 64-hex }.
check(
  'malformed envelopes are refused before any crypto (both sides)',
  openMessage(null, payload.k) === null &&
    openMessage({ c: 1, m: 'x' }, payload.k) === null &&
    mobileOpen({ c: 'x' }, payload.k) === null &&
    mobileOpen({ c: 'x', m: 'short' }, payload.k) === null,
);

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
