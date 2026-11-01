/**
 * ONE place that knows where the SteemAuthenticator checkout lives.
 *
 * Every verify script consumes the app's real sources through this module
 * (they are the protocol source of truth — reimplementing them would make
 * the tests tautological). Resolution order:
 *
 *   1. STEEMAUTHENTICATOR_DIR          (explicit override, any machine/CI)
 *   2. ../../../SteemAuth              (the app's new home — post-rename)
 *   3. ../../../sa                     (the app's pre-rename home)
 *   4. ../../SteemAuthenticator        (the documented sibling layout)
 *
 * The first candidate containing src/lib/protocol.ts wins; if none do, the
 * error says exactly which paths were tried. Moving the app again = one env
 * var or edit here — no other file references its location.
 *
 * Modules are loaded dynamically because import specifiers cannot be chosen
 * at runtime; the test suites are behavioral, so API drift surfaces at run
 * time (npm test) rather than at compile time — the app repo runs its own
 * `tsc --noEmit` gate for type errors.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const candidates = [
  process.env.STEEMAUTHENTICATOR_DIR,
  resolve(HERE, '..', '..', '..', 'SteemAuth'), // the app lives here
  resolve(HERE, '..', '..', 'SteemAuthenticator'), // documented sibling layout
].filter((c): c is string => Boolean(c));

const APP_ROOT = candidates.find((c) =>
  existsSync(resolve(c, 'src', 'lib', 'protocol.ts')),
);

if (!APP_ROOT) {
  throw new Error(
    [
      'SteemAuthenticator checkout not found — the verify suites cross-check',
      'against its real sources. Fix ONE of:',
      '  - export STEEMAUTHENTICATOR_DIR="path/to/SteemAuthenticator"',
      '  - clone it as a sibling: ../SteemAuthenticator',
      'Looked in:',
      ...candidates.map((c) => `  - ${c}`),
    ].join('\n'),
  );
}

const load = (rel: string): Promise<any> =>
  import(pathToFileURL(resolve(APP_ROOT, rel)).href);

/** The app's protocol module: parseSessionQr, sealMessage/openMessage, … */
const protocol = await load('src/lib/protocol.ts');
/** The app's operation validation: validateOperationBatch. */
const decoder = await load('src/lib/steem/decoder.ts');
/** The app's serializer: SUPPORTED_OPERATIONS, serializeOperation. */
const serializer = await load('src/lib/steem/serializer.ts');
/** The app's binary writer: ByteWriter (used to prove ops really encode). */
const bytes = await load('src/lib/steem/bytes.ts');

export const mobile = { protocol, decoder, serializer, bytes } as const;

/** Which checkout we actually loaded (printed by suites for traceability). */
export const MOBILE_ROOT = APP_ROOT;
