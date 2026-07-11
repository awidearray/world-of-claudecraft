// Meteora Dynamic Bonding Curve venue (launchpad phase 4): the production
// implementation of the LaunchVenue seam in realm_launchpad.ts, over
// @meteora-ag/dynamic-bonding-curve-sdk (PRD D3). One founder-signed
// transaction creates the per-realm partner config AND the virtual pool; the
// pool creates the base mint itself (Token-2022, immutable authority), the
// founder vesting is escrowed at migration through the SAME Jupiter Lock
// program phase 3 verifies, migration is DAMM v2 with 100 percent permanently
// locked LP, and the levy + treasury buckets ride in the leftover to the
// pinned leftover receiver.
//
// Reads are always LIVE: configFacts / poolState / migrationState normalize
// freshly fetched accounts (thresholds, fees, reserves, sqrt price), never an
// env value or a cached plan. The migration-step transactions (create locker,
// migrate, withdraw leftover) are permissionless cranks exposed as builders
// for the phase-5 keeper; this module signs NOTHING except the transient
// config/baseMint keypairs at launch-quote time (generated, sign, discarded),
// mirroring the phase-3 mint factory.

import {
  buildCurve,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  deriveBaseKeyForLocker,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  deriveEscrow,
  getCurrentPoint,
  MigrationFeeOption,
  MigrationOption,
  type PoolConfig,
  TokenAuthorityOption,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type CurveConfigFacts,
  type CurveLaunchPlan,
  type CurveMigrationState,
  type CurvePoolState,
  curveProgressBps,
  type LaunchVenue,
  type PreparedCurveLaunch,
} from './realm_launchpad';
import { SOLANA_RPC_URL } from './solana_rpc';

// The DBC activation clock we configure pools with (1 = timestamp).
const ACTIVATION_TYPE_TIMESTAMP = 1;
// The customizable migration-fee option: the LP fee of the graduated DAMM v2
// pool comes from migratedPoolFee, not a fixed tier.
const MIGRATED_POOL_FEE_BPS = 200;

// Pure: the SDK ConfigParameters for a pinned launch plan. buildCurve derives
// the curve points so that exactly `liquidityPercent` of supply migrates,
// `leftoverTokens` remain withdrawable only by the leftover receiver, the
// founder bucket vests through the locker, and the rest sells on the curve.
export function dbcConfigParameters(plan: CurveLaunchPlan) {
  return buildCurve({
    percentageSupplyOnMigration: plan.liquidityPercent,
    migrationQuoteThreshold: plan.migrationQuoteThresholdHuman,
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: plan.decimals,
      tokenQuoteDecimal: plan.quoteDecimals,
      // Mint + metadata immutable from birth: the rug summary's "authorities
      // renounced" holds by construction on the curve path.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: plan.supplyTokens,
      leftover: plan.leftoverTokens,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: 1, // FeeSchedulerExponential: the decaying anti-snipe fee
        feeSchedulerParam: {
          startingFeeBps: plan.fees.startingFeeBps,
          endingFeeBps: plan.fees.endingFeeBps,
          numberOfPeriod: plan.fees.numberOfPeriod,
          totalDuration: plan.fees.totalDurationSec,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: 0, // quote token only: fees accrue in SOL/USDC
      creatorTradingFeePercentage: plan.fees.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: MIGRATED_POOL_FEE_BPS,
      },
    },
    // 100 percent of the migrated LP is PERMANENTLY locked (nothing
    // withdrawable, ever); the split only routes the ongoing fee claims.
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: plan.founderVestingTokens,
      numberOfVestingPeriod: plan.vesting.numberOfPeriod,
      cliffUnlockAmount: 0,
      totalVestingDuration: plan.vesting.numberOfPeriod * plan.vesting.frequencySec,
      cliffDurationFromMigrationTime: plan.vesting.cliffFromMigrationSec,
    },
    activationType: ACTIVATION_TYPE_TIMESTAMP,
  });
}

// Pure: normalize a fetched PoolConfig account into the venue-agnostic facts
// the confirm step verifies. Exported for the unit tests to drive with
// fixture accounts.
export function normalizeDbcConfig(config: PoolConfig): CurveConfigFacts {
  const v = config.lockedVestingConfig;
  return {
    quoteMint: config.quoteMint.toBase58(),
    feeClaimer: config.feeClaimer.toBase58(),
    leftoverReceiver: config.leftoverReceiver.toBase58(),
    tokenType2022: config.tokenType === TokenType.Token2022,
    tokenAuthorityImmutable: config.tokenUpdateAuthority === TokenAuthorityOption.Immutable,
    tokenDecimal: config.tokenDecimal,
    migrationOptionDammV2: config.migrationOption === MigrationOption.MET_DAMM_V2,
    permanentLockedLiquidityPercent:
      config.partnerPermanentLockedLiquidityPercentage +
      config.creatorPermanentLockedLiquidityPercentage,
    withdrawableLiquidityPercent:
      config.partnerLiquidityPercentage + config.creatorLiquidityPercentage,
    migrationQuoteThresholdBase: BigInt(config.migrationQuoteThreshold.toString()),
    lockedVesting: {
      cliffUnlockBase: BigInt(v.cliffUnlockAmount.toString()),
      amountPerPeriodBase: BigInt(v.amountPerPeriod.toString()),
      numberOfPeriod: BigInt(v.numberOfPeriod.toString()),
      frequencySec: BigInt(v.frequency.toString()),
      cliffFromMigrationSec: BigInt(v.cliffDurationFromMigrationTime.toString()),
    },
  };
}

// The founder-vesting locker escrow the DBC migration creates: the SAME
// escrow PDA scheme phase 3's jup_lock.ts decodes and verifies.
export function dbcLockerEscrow(poolAddress: string): string {
  return deriveEscrow(deriveBaseKeyForLocker(new PublicKey(poolAddress))).toBase58();
}

export class MeteoraDbcVenue implements LaunchVenue {
  readonly name = 'meteora_dbc' as const;
  private readonly connection: Connection;
  private readonly client: DynamicBondingCurveClient;

  constructor(rpcUrl: string = SOLANA_RPC_URL) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.client = new DynamicBondingCurveClient(this.connection, 'confirmed');
  }

  async prepareCurveLaunch(args: {
    plan: CurveLaunchPlan;
    founderWallet: string;
    symbol: string;
    name: string;
    uri: string;
  }): Promise<PreparedCurveLaunch | null> {
    const founder = new PublicKey(args.founderWallet);
    // TRANSIENT keypairs, exactly like the phase-3 mint factory: they sign
    // this one transaction (the config account and the pool-created mint must
    // co-sign their own creation) and are discarded.
    const configKeypair = Keypair.generate();
    const baseMintKeypair = Keypair.generate();
    const params = dbcConfigParameters(args.plan);
    const tx: Transaction = await this.client.partner.createConfigAndPool({
      ...params,
      config: configKeypair.publicKey,
      feeClaimer: new PublicKey(args.plan.feeClaimer),
      leftoverReceiver: new PublicKey(args.plan.leftoverReceiver),
      quoteMint: new PublicKey(args.plan.quoteMint),
      payer: founder,
      preCreatePoolParam: {
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        poolCreator: founder,
        baseMint: baseMintKeypair.publicKey,
      },
    });
    const { blockhash } = await this.connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = founder;
    tx.partialSign(configKeypair, baseMintKeypair);
    const poolAddress = deriveDbcPoolAddress(
      new PublicKey(args.plan.quoteMint),
      baseMintKeypair.publicKey,
      configKeypair.publicKey,
    );
    return {
      txBase64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      configAddress: configKeypair.publicKey.toBase58(),
      poolAddress: poolAddress.toBase58(),
      baseMint: baseMintKeypair.publicKey.toBase58(),
    };
  }

  async configFacts(configAddress: string): Promise<CurveConfigFacts | null> {
    const config = await this.client.state.getPoolConfig(configAddress);
    return config ? normalizeDbcConfig(config) : null;
  }

  async poolState(poolAddress: string): Promise<CurvePoolState | null> {
    const pool = await this.client.state.getPool(poolAddress);
    if (!pool) return null;
    const state = pool.poolState;
    const config = await this.client.state.getPoolConfig(state.config);
    if (!config) return null;
    const quoteReserveBase = BigInt(state.quoteReserve.toString());
    const thresholdBase = BigInt(config.migrationQuoteThreshold.toString());
    return {
      configAddress: state.config.toBase58(),
      baseMint: state.baseMint.toBase58(),
      creator: state.creator.toBase58(),
      sqrtPrice: BigInt(state.sqrtPrice.toString()),
      quoteReserveBase,
      baseReserveBase: BigInt(state.baseReserve.toString()),
      migrationQuoteThresholdBase: thresholdBase,
      progressBps: curveProgressBps(quoteReserveBase, thresholdBase),
      isMigrated: Number(state.isMigrated) !== 0,
      isLeftoverWithdrawn: Number(state.isWithdrawLeftover) !== 0,
      partnerQuoteFeeBase: BigInt(state.partnerQuoteFee.toString()),
      partnerBaseFeeBase: BigInt(state.partnerBaseFee.toString()),
    };
  }

  async migrationState(poolAddress: string): Promise<CurveMigrationState | null> {
    const pool = await this.client.state.getPool(poolAddress);
    if (!pool) return null;
    const state = pool.poolState;
    const isMigrated = Number(state.isMigrated) !== 0;
    const config = await this.client.state.getPoolConfig(state.config);
    if (!config) return null;
    let dammV2Pool: string | null = null;
    if (isMigrated) {
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
      const derived = deriveDammV2PoolAddress(dammConfig, state.baseMint, config.quoteMint);
      const exists = await this.connection.getAccountInfo(derived);
      dammV2Pool = exists ? derived.toBase58() : null;
    }
    const lockerEscrow = dbcLockerEscrow(poolAddress);
    const lockerExists = await this.connection.getAccountInfo(new PublicKey(lockerEscrow));
    return {
      isMigrated,
      dammV2Pool,
      lockerEscrow: lockerExists ? lockerEscrow : null,
    };
  }

  async sellQuote(poolAddress: string, amountBase: bigint): Promise<bigint | null> {
    if (amountBase <= 0n) return null;
    const pool = await this.client.state.getPool(poolAddress);
    if (!pool) return null;
    const state = pool.poolState;
    if (Number(state.isMigrated) !== 0) return null;
    const config = await this.client.state.getPoolConfig(state.config);
    if (!config) return null;
    // A completed-but-unmigrated curve has no quote (the SDK throws on it).
    if (BigInt(state.quoteReserve.toString()) >= BigInt(config.migrationQuoteThreshold.toString()))
      return null;
    const currentPoint = await getCurrentPoint(this.connection, config.activationType);
    // The SDK's API for "this size cannot be quoted" (a thin curve with too
    // little quote liquidity to pay the sale out) is a throw; that is exactly
    // the ILLIQUID answer, so it maps to null (phase 6 excludes, never zeroes).
    try {
      const quote = this.client.pool.swapQuote({
        virtualPool: pool,
        config,
        swapBaseForQuote: true,
        amountIn: new BN(amountBase.toString()),
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
      });
      return BigInt((quote as unknown as { outputAmount: BN }).outputAmount.toString());
    } catch {
      return null;
    }
  }

  // ── Migration-step builders (permissionless cranks for the phase-5 keeper) ──

  async buildCreateLockerTx(poolAddress: string, payer: string): Promise<Transaction> {
    return this.client.migration.createLocker({
      pool: new PublicKey(poolAddress),
      payer: new PublicKey(payer),
    });
  }

  async buildMigrateToDammV2Tx(
    poolAddress: string,
    payer: string,
  ): Promise<{ transaction: Transaction; signers: Keypair[] }> {
    const response = await this.client.migration.migrateToDammV2({
      payer: new PublicKey(payer),
      pool: new PublicKey(poolAddress),
      dammConfig: await this.dammMigrationConfig(poolAddress),
    });
    return {
      transaction: response.transaction,
      signers: [response.firstPositionNftKeypair, response.secondPositionNftKeypair],
    };
  }

  async buildWithdrawLeftoverTx(poolAddress: string, payer: string): Promise<string | null> {
    const tx = await this.client.migration.withdrawLeftover({
      pool: new PublicKey(poolAddress),
      payer: new PublicKey(payer),
    });
    const { blockhash } = await this.connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = new PublicKey(payer);
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
  }

  async buildClaimPartnerFeeTx(args: {
    poolAddress: string;
    feeClaimer: string;
    payer: string;
    receiver: string;
    maxQuoteBase: bigint;
  }): Promise<Transaction> {
    return this.client.partner.claimPartnerTradingFee({
      feeClaimer: new PublicKey(args.feeClaimer),
      payer: new PublicKey(args.payer),
      pool: new PublicKey(args.poolAddress),
      maxBaseAmount: new BN(0),
      maxQuoteAmount: new BN(args.maxQuoteBase.toString()),
      receiver: new PublicKey(args.receiver),
    });
  }

  private async dammMigrationConfig(poolAddress: string): Promise<PublicKey> {
    const pool = await this.client.state.getPool(poolAddress);
    if (!pool) throw new Error('pool not found');
    const config = await this.client.state.getPoolConfig(pool.poolState.config);
    if (!config) throw new Error('pool config not found');
    return DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  }
}
