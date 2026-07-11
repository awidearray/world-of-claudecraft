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
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { associatedTokenAccount, transferCheckedIx } from './payout_keeper';
import type { RealmFeeGateway, SignedTx } from './realm_fee_keeper';
import type {
  CurveState,
  DbcGateway,
  GraduationState,
  LaunchpadPartnerConfig,
} from './realm_launchpad';
import {
  fetchFinalizedTransaction,
  parseNativePayment,
  parseSplitPayment,
  SOLANA_RPC_URL,
  signatureStatus,
  solanaRpc,
} from './solana_rpc';

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

// ── Live fee gateway (phase 5) ───────────────────────────────────────────────

// The realm-fee keeper's chain surface: reads the pool's claimable partner
// quote fees, builds + signs the SDK's partner fee claim with the ops-owned
// fee-claimer key (the DBC config's feeClaimer, the same keeper-key model as
// the buyback vault), measures what actually arrived, and builds the one
// distribution transaction paying the split legs. This wiring is the ONLY
// code that touches the fee-claimer key.
export function liveRealmFeeGateway(
  claimerSecret: string,
  rpcUrl: string = SOLANA_RPC_URL,
): RealmFeeGateway {
  const claimer = Keypair.fromSecretKey(bs58.decode(claimerSecret));
  const claimerWallet = claimer.publicKey.toBase58();
  const connection = new Connection(rpcUrl, 'confirmed');
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');

  const signed = (tx: Transaction): SignedTx => {
    tx.sign(claimer);
    const raw = tx.serialize();
    const sigBytes = tx.signature;
    if (!sigBytes) throw new Error('transaction signing produced no signature');
    return {
      signature: bs58.encode(sigBytes),
      send: async () => {
        await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
      },
    };
  };

  return {
    async claimableQuoteFees(poolAddress: string): Promise<bigint | null> {
      try {
        const pool = await dbc.state.getPool(poolAddress);
        if (!pool) return null;
        return bn(pool.poolState.partnerQuoteFee);
      } catch {
        return null;
      }
    },

    async signClaim(args: { poolAddress: string; maxQuoteBase: bigint }): Promise<SignedTx | null> {
      try {
        const tx = await dbc.partner.claimPartnerTradingFee({
          feeClaimer: claimer.publicKey,
          payer: claimer.publicKey,
          pool: new PublicKey(args.poolAddress),
          // Quote fees only: base-token fees stay accrued on-chain (the split
          // is denominated in the quote asset).
          maxBaseAmount: new BN(0),
          maxQuoteAmount: new BN(args.maxQuoteBase.toString()),
        });
        tx.feePayer = claimer.publicKey;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        return signed(tx);
      } catch {
        return null;
      }
    },

    confirm: signatureStatus,

    async receivedQuote(claimSig: string, quoteMint: string): Promise<bigint> {
      const tx = await fetchFinalizedTransaction(claimSig);
      if (!tx) return 0n;
      const delta =
        quoteMint === ''
          ? (parseNativePayment(tx).lamportDeltas.get(claimerWallet) ?? 0n)
          : (parseSplitPayment(tx, quoteMint).tokenDeltas.get(claimerWallet) ?? 0n);
      return delta > 0n ? delta : 0n;
    },

    async signDistribute(args: {
      quoteMint: string;
      legs: Array<{ dest: string; amountBase: bigint }>;
    }): Promise<SignedTx | null> {
      try {
        const tx = new Transaction();
        tx.feePayer = claimer.publicKey;
        if (args.quoteMint === '') {
          for (const leg of args.legs) {
            tx.add(
              SystemProgram.transfer({
                fromPubkey: claimer.publicKey,
                toPubkey: new PublicKey(leg.dest),
                lamports: leg.amountBase,
              }),
            );
          }
        } else {
          const mint = new PublicKey(args.quoteMint);
          const decimals = await quoteDecimals(args.quoteMint);
          if (decimals === null) return null;
          const source = associatedTokenAccount(claimer.publicKey, mint);
          for (const leg of args.legs) {
            const owner = new PublicKey(leg.dest);
            tx.add(
              createAtaIdempotentIx(claimer.publicKey, owner, mint),
              transferCheckedIx(
                source,
                mint,
                associatedTokenAccount(owner, mint),
                claimer.publicKey,
                leg.amountBase,
                decimals,
              ),
            );
          }
        }
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        return signed(tx);
      } catch {
        return null;
      }
    },
  };
}

const decimalsCache = new Map<string, number>();
async function quoteDecimals(mint: string): Promise<number | null> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const res = await solanaRpc<{ value?: { decimals?: number } }>('getTokenSupply', [mint]);
  const d = res?.value?.decimals;
  if (typeof d !== 'number') return null;
  decimalsCache.set(mint, d);
  return d;
}

// Associated-token-account CreateIdempotent (instruction discriminator 1): a
// no-op when the destination ATA already exists, so a distribution leg never
// fails on a first-time recipient.
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = associatedTokenAccount(owner, mint);
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
