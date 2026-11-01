# The relay plane (protocol v3) — design & contract

**This is the only transport.** The Supabase message plane (v2) and the
stateless WebSocket relay (v1) are both gone: v3 puts durability *inside*
the relay the client already trusts. A room is a **sequenced log** owned by
`steemauth-relay` — push (live fanout) + pull (replay from your cursor) —
so backgrounded phones, page refreshes and network handoffs lose nothing,
without shipping any database credential to a client, ever.

> Source of truth: `steemauth-relay/server.js` (the relay) and
> `SteemAuthenticator/src/lib/messagePlane.ts` (the app client);
> `src/relay-plane.ts` mirrors it here. The suites:
> `verify-relay-plane.ts` drives a REAL relay over REAL sockets (always
> runs — no credentials needed); `verify-e2e.ts` proves the same semantics
> offline through the injected `planeFactory`.

## Principles

1. **No crypto change, one upgrade** — payloads are AES envelopes like
   always (`k` from the QR is still the only capability) plus an HMAC tag
   (`{ c, m }`): the relay can neither read messages nor inject one that
   verifies. Encrypt-then-MAC, keys domain-separated from the cipher KDF.
2. **Token-authenticated rooms** — the QR carries the room (`rm`) and the
   PHONE token (`tk`); the app keeps its own token and registers the room
   with **sha256 hashes of both**. The relay stores hashes, compares in
   constant time, and only the app token can rotate the phone token or
   close the room. Failed joins ban the IP.
3. **Per-room sequenced logs** — `seq` starts at 1 per room; senders await
   an `ack`; receivers deliver `seq > cursor` and re-pull on every
   (re)join. A room starts fresh per session, so no cross-session residue
   can ever replay into it.
4. **Nothing to configure** — the endpoint is a public constant
   (`wss://relay.steempro.com`) already visible in every QR. Self-hosters
   pass `relayUrl`. There is no config endpoint and no credential surface:
   `/healthz` is the entire HTTP API.

## Endpoint resolution

| Source | When |
|---|---|
| `DEFAULT_RELAY_URL` | zero-config — hardcoded, public, nothing to fetch |
| `options.relayUrl` / QR `rt` | self-hosters pin their own relay |

The sync `new SteemAuthSession()` works with zero options — room + tokens
are generated client-side, and `connect()` registers the room. Discovery,
config endpoints and embedded credentials are gone by design.

## Lifecycle & resume

- `connect()` (before showing the QR): `create` (room + token hashes + ttl)
  → `join` → `pull` — resolving only once the plane is live, so the
  phone's `ready` row can never race ahead of the subscription.
- Room ttl = the QR window + slack, extended by activity; the relay sweeps
  idle rooms (default 15 min idle / 60 min hard cap) and deletes their rows
  with them.
- `persistSession: true` keeps `{ payload, app token, handshake, pending
  request }` in `sessionStorage` — `resume()` re-joins the same room with
  the persisted app token, replays whatever the refresh missed and re-sends
  an in-flight request with the **same `id`** (receivers key pending state
  by id, so it's a re-show, not a duplicate). The app token lives only in
  that snapshot — never in the QR, never on disk.
- Revocation rides the room log as a `revoke` row — durable within the
  room's lifetime, which is exactly the session's lifetime.

## Limits & hygiene (enforced by the relay)

- envelope ≤ 64 KB, frame ≤ 70 KB, ≤ 4 members/room, 20 msg/s/connection;
- per-IP create (10/min) and join (30/min) caps; 5 auth failures → 10-min
  IP ban; slow consumers (> 1 MB buffered) are cut;
- binary frames and malformed JSON are refused before the store;
- rooms + rows expire; the sweeper deletes them; nothing is logged.

## Migration status

1. ✅ **Relay**: v3 plane with hashed-token auth, per-room logs, replay,
   rotation, bans, TTL sweep, memory + sqlite stores (`STORE=sqlite`).
2. ✅ **Package**: `relay-plane.ts` behind the `MessagePlaneFactory` seam;
   QR carries `rt`/`rm`/`tk`; discovery, `/config` and all Supabase code
   deleted from the client; offline e2e on an injected in-memory relay.
3. ✅ **App**: relay-plane client (join/pull/replay/reconnect), `ready` as
   a row, denial notices join-and-revoke with the phone token.
4. ⏳ **Deploy**: run the relay with `STORE=sqlite` (durable) or memory;
   the Supabase project is no longer part of the session transport at all.
