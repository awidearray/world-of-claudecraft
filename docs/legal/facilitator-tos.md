# Realm Token Launchpad: non-custodial facilitator terms

> STATUS: draft terms for counsel review, not legal advice. The launchpad's
> mainnet enablement is gated on a written counsel sign-off recorded per
> `docs/legal/counsel-signoff.md`. This document states the posture the code
> already enforces so counsel can confirm the terms match the implementation.

## 1. What this service is

The Realm Token Launchpad is a **non-custodial facilitator**. It lets a realm
founder deploy a per-realm SPL Token-2022 currency through a flow that bakes in
anti-rug commitments (locked liquidity, renounced authorities, immutable founder
vesting), and it displays the resulting on-chain proof. It is **not** an issuer,
a broker-dealer, a money transmitter, an exchange, or an investment adviser.

## 2. Non-custodial, always

The server never pools, holds, or moves user funds. On every money path it
**pins a quote and verifies a finalized on-chain transaction**; the value moves
directly between the participant's wallet and a program- or founder-owned
escrow, never through a platform-held balance. The only keys the platform holds
are (a) transient mint / lock-base keypairs that sign one account-creation
transaction and are immediately discarded, and (b) the existing buyback / fee
keeper keys over their own vaults. This is the load-bearing fact for avoiding
money-services-business and state money-transmitter classification.

## 3. Structural anti-rug as a launch precondition

A realm token cannot list (its status cannot reach `live`) until, verifiably
on-chain: the liquidity is permanently locked at DAMM v2 graduation, the mint
and metadata authorities are renounced, and the founder and Levy Street Fund
allocations are in immutable Jupiter Lock vesting. These are requirements the
code enforces, not optional best practices.

## 4. Securities posture

A tradeable token with utility or revenue share can be an investment contract; a
power-convertible token raises the bar. Mitigations the platform commits to:

- No profit-promise or managerial-effort language in any launchpad copy.
- Position each token as a game currency, and the platform as a facilitator
  (never an issuer or a curator of returns).
- `power` realms (where the token buys gameplay advantage) are per-clone opt-in,
  clearly labeled "pay-to-win" to every player before they pick the realm, and
  gated behind the same mainnet sign-off as the wager features.

## 5. The Levy Street Fund is display-only

The platform-owned Levy Street Fund holds a slice of every realm token and
**displays** those holdings as a transparent portfolio. It mints no fund-share
token, sells no claim on the portfolio, and offers no redemption. That line is
what keeps it a transparent treasury rather than a pooled investment vehicle; a
written counsel memo on Investment Company Act status is a precondition to
enabling the portfolio page on mainnet.

## 6. Geo, sanctions, and jurisdiction

All money routes are screened by the `money_geo_gate` middleware: OFAC SDN
wallet screening plus IP geolocation that excludes sanctioned and in-scope
restricted jurisdictions. On a mainnet cluster the middleware **fails closed**:
a money route is refused unless the geo/OFAC gate is active AND the counsel
sign-off is recorded. VPN circumvention is not tolerated by design. Participants
represent that they are not located in, and not a resident or national of, an
excluded jurisdiction, and are not on any sanctions list.

## 7. No advice

Nothing on the platform is investment, financial, legal, or tax advice. Token
values can go to zero. Participants are solely responsible for their own
decisions and for compliance with the laws that apply to them.
