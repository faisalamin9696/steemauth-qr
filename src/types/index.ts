/**
 * Public types — one barrel so every import site keeps saying `./types`.
 *
 *   wire.ts — QR payload + realtime message shapes (mobile-app compatible)
 *   api.ts  — what integrators construct and receive (Keychain-style)
 */
export * from './wire';
export * from './api';
