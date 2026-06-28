# The Arcane Foundry — a $woc GPU‑rental marketplace

> *"Is there a way to have players with better computers rent their idle
> graphics to players with not‑so‑good computers for $woc?"*

Yes. This document describes the design and the implementation that ships in
this repo.

## The idea

Not everyone logs in on a powerful machine. A thin laptop or a phone struggles
to render the world, while plenty of other players sit on desktop GPUs that are
**mostly idle** — the card can push far more frames than one client needs.

The Arcane Foundry lets a strong machine (**the host**) lend a slice of that
idle rendering power to a weak machine (**the renter**), who pays for it by the
minute in **$woc**, the realm's render‑credit currency.

The actual rendered video and the renter's input travel **directly between the
two browsers** over WebRTC. The game server never sees a pixel — its job is the
*marketplace and the money*.

## What the server does (and doesn't)

The server is the **authoritative economy + matchmaker + signaling relay**. It
never renders or proxies frames.

| Server owns | Peers own (P2P) |
|---|---|
| $woc balances + double‑entry ledger | The rendered video stream (host → renter) |
| Rig tiers & listings (who's offering power) | The input stream (renter → host) |
| Escrow + per‑minute billing | The WebRTC media/data channels |
| Relaying the WebRTC handshake (SDP/ICE) | — |

This split matters for trust: because **only the server moves $woc**, a player
who spoofs their benchmark can at worst *advertise* a rig they don't have — and
then deliver a poor stream, which the renter simply ends. They can never mint
or steal credit.

## $woc, the currency

`$woc` is a real server‑held account balance (unlike gold/silver/copper, which
lives in a character's inventory). Every move is **double‑entry**: one wallet
decreases, another increases, recorded in an append‑only `woc_ledger`. Renting
can only ever *transfer* credit, never create or destroy it.

- New characters get a **signup stipend** (`SIGNUP_STIPEND`, 1000 $woc) on first
  login, so there are buyers from day one.
- Tables: `woc_wallets (character_id, balance)` and
  `woc_ledger (from, to, amount, reason, created_at)` — see `server/rental_db.ts`.

## Rig tiers

On login the client runs a ~0.5s benchmark (`src/net/rental.ts`):

1. reads the unmasked WebGL renderer string (`WEBGL_debug_renderer_info`);
2. times sustained frame rate against `requestAnimationFrame`;
3. combines those with core count into a **0–100 score** (`scoreRig`, a pure,
   unit‑tested function).

| Score | Tier | |
|---|---|---|
| 0–34 | `low` | typical renter |
| 35–59 | `mid` | |
| 60–81 | `high` | **may host** |
| 82–100 | `ultra` | **may host** |

Hosting requires `HOST_MIN_SCORE` (60) — the whole point is *better* machines
helping *worse* ones. The benchmark is advisory only (see trust note above).

## Lifecycle of a rental

```
HOST                         SERVER                         RENTER
  | rig_report (score 90) ----->|                              |
  | rental_list(rate,slots) --->| (listing published)          |
  |                             |<------ rental_rent(hostId) ---|
  |                             |  charge 1 min into escrow     |
  |<-- sessionStart ------------|------------ sessionStart ---->|
  |                             |                              | createOffer()
  |                             |<--- rental_signal(sdp offer)-|
  |<-- signal(offer) -----------|                              |
  | createAnswer()              |                              |
  |--- rental_signal(answer) -->|------------ signal(answer) ->|
  |  <===== ICE both ways via rental_signal relay =====>       |
  |  <========== direct WebRTC video + input (P2P) ==========> |
  |                             | every 60s: transfer rate $woc|
  |                             |   renter -> host (or end if   |
  |                             |   the renter runs dry)        |
```

- **Prepay:** the renter is charged one minute up front when the rental starts,
  so a host never streams for free.
- **Metering:** `RentalService.tickBilling()` runs once a minute from the game
  loop, transferring `ratePerMin` $woc renter → host. If the renter can't cover
  the next minute, the session ends cleanly (`insufficient_woc`).
- **Teardown:** either party can `rental_stop`; a disconnect ends the session
  and frees the host's slot automatically (`forget`).

## Wire protocol (over the existing game WebSocket)

Client → server commands (`{ t: 'cmd', cmd, ... }`):

| cmd | payload | meaning |
|---|---|---|
| `rig_report` | `rig` | report this machine's benchmark |
| `rental_list` | `rate, slots, note` | publish idle power for rent |
| `rental_unlist` | — | stop hosting |
| `rental_rent` | `hostId` | rent a listed host |
| `rental_stop` | — | end your current rental |
| `rental_connected` | — | renter: the P2P video is live |
| `rental_signal` | `session, payload` | relay an SDP/ICE handshake step |
| `rental_refresh` | — | re‑request the marketplace snapshot |

Server → client:

- `{ t: 'rental', ... }` — the full `MarketSnapshot` (balance, your rig, your
  listing, browsable listings, your active session).
- `{ t: 'events', list: [...] }` — `RentalEvent`s: `wallet` (balance update),
  `sessionStart`, `sessionEnd`, `signal` (relayed handshake), plus `log`/`error`.

## Code map

| File | Responsibility |
|---|---|
| `server/rental.ts` | `RentalService` — pure economy/matchmaking/relay logic (DB + transport abstractions) |
| `server/rental_db.ts` | `PgRentalDb` + `$woc` schema (wallets + ledger) |
| `server/game.ts` | wires the service to the live socket map, dispatches `rental_*`, runs billing |
| `src/net/rental.ts` | client: GPU benchmark + WebRTC host/renter link |
| `src/net/online.ts` | `ClientWorld` mirrors the `rental` snapshot, exposes `rental*` commands |
| `src/world_api.ts` | `RentalInfo` / listing / session view types |
| `tests/rental.test.ts` | economy suite (listing, renting, billing, escrow, signaling, teardown) |
| `tests/rental_client.test.ts` | pure `scoreRig` tiering tests |

## Status & remaining work

Shipped and tested:

- the full server‑side $woc economy, escrow, per‑minute billing, listings, and
  WebRTC signaling relay (in‑memory‑faked unit tests, no DB required);
- the client benchmark + `RentalLink` WebRTC host/renter classes;
- client snapshot mirroring + command senders;
- automatic rig benchmarking + reporting on login.

Not yet wired (next step): the **in‑game HUD panel** (browse listings, set your
rate, the renter's `<video>` surface). The data and commands it needs are all
present on `ClientWorld` (`rentalInfo`, `consumeRentalChanged()`, `rentalList()`,
`rentalRent()`, …) and the `RentalLink` helpers in `src/net/rental.ts`; the panel
is pure presentation on top of them. End‑to‑end pixel streaming also needs two
real browsers to verify and a TURN server for players behind symmetric NATs (the
included config uses a public STUN server only).
