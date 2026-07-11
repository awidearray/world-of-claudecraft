# Realm Token Launchpad: Facilitator Terms (draft for counsel review)

Status: DRAFT. This document is the phase 8 deliverable of the realm token
launchpad PRD (docs/prd/woc/realm-token-launchpad.md, section 10). It is not
legal advice and it is not in force: written counsel sign-off, recorded in the
`REALM_COUNSEL_SIGNOFF` deployment setting, is a precondition to enabling any
launchpad money surface on mainnet. The in-client disclosure
(`launchpad.termsNote`) summarizes this document and links buyers here.

## 1. What World of ClaudeCraft is (and is not)

1. World of ClaudeCraft ("the platform") is a NON-CUSTODIAL FACILITATOR of
   realm token launches. The platform never takes custody of user funds or
   tokens: every transfer moves directly between user wallets, founder escrow
   wallets, on-chain locking programs (Jupiter Lock), and on-chain trading
   venues (Meteora DBC / DAMM v2). The platform's servers verify finalized
   transactions; they do not sign, hold, pool, or forward value.
2. The platform is NOT the issuer of any realm token. Realm tokens are created
   by realm founders through their own wallets. The platform is not a broker,
   dealer, exchange, money-services business, money transmitter, or investment
   adviser, and it does not curate or endorse tokens.
3. Nothing on the platform is an offer of securities or a promise of profit.
   Realm tokens are game currencies for their realm. Their tradability on
   public venues does not make them investments, and no platform copy,
   interface, or communication should be read as suggesting expected returns
   from the efforts of the platform or any founder.

## 2. Structural protections (enforced in code, not promised in prose)

1. Fixed supply, 9 decimals, no freeze authority, no transfer fee, no transfer
   hook, no permanent delegate, no pausable extension; mint authority is
   renounced after distribution. A token that fails any of these checks cannot
   list (server verification, phase 3).
2. Founder, platform-fund, and realm-treasury allocations are locked in
   immutable on-chain vesting escrows (non-cancelable, recipient-locked)
   before listing. Public allocation floor and insider caps are enforced by
   construction (phase 3).
3. Graduated liquidity is permanently locked (phase 4). The platform fund is
   display-only: no fund share is sold and nothing is redeemable (phase 6).

## 3. Eligibility and restricted regions

1. The launchpad's money surfaces (voting, presale contribution, mint
   creation, curve listing, fee claims, and token-to-copper conversion) are
   unavailable to persons in jurisdictions subject to comprehensive OFAC
   sanctions, persons on the OFAC SDN list, and any jurisdiction the platform
   restricts for retail participation.
2. Enforcement is technical as well as contractual: requests from excluded
   regions are refused (HTTP 451) by IP geolocation at the edge, unplaceable
   or anonymized origins (unknown country, Tor exits) are refused while the
   gate is active, and linked wallets are screened against the OFAC SDN
   digital-currency address list. Attempting to circumvent these controls
   (including via VPN) is a violation of these terms.

## 4. Pay-to-win labeling

1. A realm founder chooses the token's monetization policy at registration.
   The default, and the only policy available on the canonical realm, is
   `cosmetic`: the token buys no gameplay advantage.
2. A `power` realm, where the token converts to in-game currency, is plainly
   labeled as pay-to-win on its launchpad page before any purchase surface,
   and the conversion is additionally gated platform-wide behind the same
   compliance flags as every other money surface.

## 5. No advice, no warranty

Realm tokens can lose all value. The platform provides the launch mechanics
and the on-chain verification checklist; it does not vet founders, audit
realms, or guarantee liquidity. Users are responsible for their own
jurisdictional compliance and taxes.

## 6. Counsel gate (deployment precondition)

The following must exist before any mainnet enablement, and their absence
hard-disables the gated features at boot (server/compliance_gate.ts):

1. Written counsel sign-off on these terms, on the securities posture of
   tradeable realm tokens and `power` realms, and on the Investment Company
   Act status of the display-only platform fund; recorded as
   `REALM_COUNSEL_SIGNOFF=<memo reference>`.
2. The IP geo gate enabled (`REALM_GEO_GATE_ENABLED=1`).
3. The OFAC SDN wallet screen enabled (`REALM_OFAC_SCREEN_ENABLED=1`).
