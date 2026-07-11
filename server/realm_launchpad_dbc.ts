// The live Meteora binding for the DbcGateway seam (realm_launchpad.ts):
// wraps @meteora-ag/dynamic-bonding-curve-sdk (curve/config/pool) and
// @meteora-ag/cp-amm-sdk (DAMM v2 graduation state). This is the ONLY module
// that imports the Meteora SDKs, so the adapter stays unit-testable with
// fixtures and a Raydium gateway is a sibling file away.
//
// Reads resolve against the one server RPC (SOLANA_RPC_URL). Every read maps
// SDK/RPC failures to null (callers treat "can't read" as "not verified").
// The single write-path helper, buildCreatePoolTx, builds the SDK's createPool
// transaction and partial-signs with a TRANSIENT base-mint keypair generated
// here and discarded before returning: the DBC program is what creates the
// token, and the founder co-signs and pays.

import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type {
  CurveState,
  DbcGateway,
  GraduationState,
  LaunchpadPartnerConfig,
} from './realm_launchpad';
import { SOLANA_RPC_URL } from './solana_rpc';

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

function bn(v: { toString(): string } | null | undefined): bigint {
  return v == null ? 0n : BigInt(v.toString());
}

export function liveDbcGateway(rpcUrl: string = SOLANA_RPC_URL): DbcGateway {
  const connection = new Connection(rpcUrl, 'confirmed');
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const cpAmm = new CpAmm(connection);

  return {
    async getPoolConfig(configAddress: string): Promise<LaunchpadPartnerConfig | null> {
      try {
        const config = await dbc.state.getPoolConfig(configAddress);
        if (!config) return null;
        const vesting = config.lockedVestingConfig;
        const lockedVestingPresent =
          bn(vesting?.amountPerPeriod) * bn(vesting?.numberOfPeriod) +
            bn(vesting?.cliffUnlockAmount) >
          0n;
        const quoteMint = config.quoteMint.toBase58();
        return {
          configAddress,
          quoteMint: quoteMint === NATIVE_SOL_MINT ? '' : quoteMint,
          feeClaimer: config.feeClaimer.toBase58(),
          migrationQuoteThresholdBase: bn(config.migrationQuoteThreshold),
          migrationOption: Number(config.migrationOption),
          tokenType: Number(config.tokenType),
          // On-chain these are whole percentages (0..100); the seam speaks bps.
          partnerLockedLpBps: Number(config.partnerPermanentLockedLiquidityPercentage) * 100,
          creatorLockedLpBps: Number(config.creatorPermanentLockedLiquidityPercentage) * 100,
          lockedVestingPresent,
        };
      } catch {
        return null;
      }
    },

    async getPoolByBaseMint(baseMint: string): Promise<CurveState | null> {
      try {
        const found = await dbc.state.getPoolByBaseMint(baseMint);
        if (!found) return null;
        const pool = found.account.poolState;
        return {
          poolAddress: found.publicKey.toBase58(),
          configAddress: pool.config.toBase58(),
          baseMint: pool.baseMint.toBase58(),
          creator: pool.creator.toBase58(),
          quoteReserveBase: bn(pool.quoteReserve),
          sqrtPrice: bn(pool.sqrtPrice),
          migrated: Number(pool.isMigrated) !== 0,
        };
      } catch {
        return null;
      }
    },

    async buildCreatePoolTx(args: {
      configAddress: string;
      payer: string;
      poolCreator: string;
      name: string;
      symbol: string;
      uri: string;
    }): Promise<{ txBase64: string; baseMint: string } | null> {
      try {
        const baseMintKeypair = Keypair.generate();
        const payer = new PublicKey(args.payer);
        const tx = await dbc.creator.createPool({
          name: args.name,
          symbol: args.symbol,
          uri: args.uri,
          payer,
          poolCreator: new PublicKey(args.poolCreator),
          config: new PublicKey(args.configAddress),
          baseMint: baseMintKeypair.publicKey,
        });
        tx.feePayer = payer;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        // Token-2022 configs derive the mint program-side and need no mint
        // signature; the SPL path requires the transient keypair to sign.
        if (tx.signatures.some((s) => s.publicKey.equals(baseMintKeypair.publicKey))) {
          tx.partialSign(baseMintKeypair);
        }
        return {
          txBase64: tx
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString('base64'),
          baseMint: baseMintKeypair.publicKey.toBase58(),
        };
      } catch {
        return null;
      }
    },

    async getDammV2PoolLock(args: {
      baseMint: string;
      quoteMint: string;
    }): Promise<GraduationState | null> {
      try {
        const quote = args.quoteMint === '' ? NATIVE_SOL_MINT : args.quoteMint;
        const pools = await cpAmm.fetchPoolStatesByTokenAMint(new PublicKey(args.baseMint));
        const match = pools.find(
          (p) => p.account.tokenBMint.toBase58() === quote && bn(p.account.liquidity) > 0n,
        );
        if (!match) return null;
        return {
          dammPoolAddress: match.publicKey.toBase58(),
          liquidity: bn(match.account.liquidity),
          permanentLockedLiquidity: bn(match.account.permanentLockLiquidity),
        };
      } catch {
        return null;
      }
    },
  };
}
