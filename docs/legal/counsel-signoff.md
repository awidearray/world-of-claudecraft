# Launchpad mainnet enablement: counsel sign-off + gate checklist

The Realm Token Launchpad's risky money surfaces (a tradeable per-realm token,
`power`-convertible realms, the Levy Street Fund portfolio page) are FLAG-GATED
and default-off. They may be enabled on a mainnet cluster ONLY after every gate
below is satisfied. The code enforces the last two mechanically; the rest are
human gates recorded here.

## The gate checklist (all required for mainnet)

1. [ ] **Counsel sign-off recorded.** A written memo from counsel covering: the
       non-custodial facilitator posture (`docs/legal/facilitator-tos.md`), the
       Investment Company Act status of the display-only Levy Street Fund, the
       securities analysis of `power`-convertible tokens, and the safe-copy
       rules for the portfolio page. Record its id + date in
       `LAUNCHPAD_COUNSEL_SIGNOFF` (a non-empty value is the machine gate;
       `counselSignoffRecorded()` reads it).
2. [ ] **Allocation split re-confirmed with counsel** (public curve / liquidity
       / founder / Levy Street Fund / treasury, and the vesting schedules) per
       PRD section 7's env-tunable table.
3. [ ] **Geo + OFAC gate active.** `MONEY_GEO_GATE_ENABLED=1`, a current
       `OFAC_SDN_WALLETS` / `OFAC_SDN_WALLETS_FILE`, and the
       `MONEY_BLOCKED_COUNTRIES` list confirmed with counsel. On mainnet the
       `money_geo_gate` middleware FAILS CLOSED without this (every money route
       returns 403 `geo_gate_required`).
4. [ ] **RugCheck / Birdeye clean score** verified for the launch mint profile
       (renounced mint authority, no freeze, no permanent delegate / transfer
       hook, immutable metadata) per the `mintRugSummary` acceptance test.
5. [ ] **Phase-4 mainnet dry-run** signed off by the owner (a real curve launch
       + graduation on mainnet with a small size).
6. [ ] **Fee-account / treasury key material** provisioned by ops (never
       committed): the fee-claimer PDA, the fee keeper vault, the power sink
       wallet, and the Levy Street Fund wallet.

## Machine-enforced gates (already in the code)

- `mainnetMoneyEnabled(featureFlag, rpcUrl)` (`server/money_geo_gate.ts`): a
  risky money feature runs on mainnet ONLY when its own flag is on AND the geo
  gate is enabled AND the counsel sign-off is recorded. On devnet the flag alone
  suffices (the money is not real).
- The money-route middleware screens every mutating token-money route
  (vote / presale / mint / distribute / lock / curve / power-credit) and, on
  mainnet, refuses to serve without the gate + counsel in place.

## Sign-off record

| Item | Value | Recorded by | Date |
|---|---|---|---|
| Counsel memo id | _pending_ | | |
| Allocation re-confirmed | _pending_ | | |
| Geo/OFAC list source | _pending_ | | |
| Phase-4 mainnet dry-run | _pending_ | | |

Until every row is filled and the corresponding env is set on the mainnet
deploy, the launchpad money surfaces stay off.
