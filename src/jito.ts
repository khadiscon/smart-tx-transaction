/**
 * src/jito.ts
 * On-chain tip estimation + Jito bundle submission.
 *
 * Bundle structure: a single versioned transaction whose LAST instruction is
 * the tip transfer. Including the tip in the same transaction write-locks the
 * tip account, which is what the Jito block engine requires.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  BlockhashWithExpiryBlockHeight,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { logger } from "./logger";

const JITO_ENDPOINTS = [
  config.jitoBlockEngineUrl,
  "https://amsterdam.mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
  "https://mainnet.block-engine.jito.wtf",
].filter((url, i, arr) => arr.indexOf(url) === i);

const JITO_TIP_FLOOR_URLS = [
  "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
  ...JITO_ENDPOINTS.map((endpoint) => `${endpoint}/api/v1/bundles/tip_floor`),
].filter((url, i, arr) => arr.indexOf(url) === i);

let cachedTipAccounts: PublicKey[] | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getLatestBlockhashWithRetry(
  connection: Connection,
  attempts = 3
): Promise<BlockhashWithExpiryBlockHeight> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (err: any) {
      lastErr = err;
      logger.warn(`[rpc] getLatestBlockhash attempt ${i + 1}/${attempts} failed: ${err.message}`);
      if (i < attempts - 1) await sleep(1_000 * (i + 1));
    }
  }
  throw new Error(`[rpc] getLatestBlockhash failed after ${attempts} attempts: ${lastErr?.message}`);
}

async function jitoRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  let lastError = "Jito RPC unavailable";

  for (const endpoint of JITO_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${endpoint}/api/v1/bundles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });

        if (res.status === 429) {
          lastError = `HTTP 429 from ${endpoint}`;
          await sleep(1_000 * (attempt + 1));
          continue;
        }

        if (!res.ok) {
          lastError = `HTTP ${res.status} from ${endpoint}: ${await res.text()}`;
          break;
        }

        const json: any = await res.json();
        if (json.error) {
          lastError = `RPC error from ${endpoint}: ${JSON.stringify(json.error)}`;
          if (json.error?.code === -32097) {
            await sleep(1_000 * (attempt + 1));
            continue;
          }
          break;
        }

        return json.result as T;
      } catch (err: any) {
        lastError = err.message ?? String(err);
        await sleep(500 * (attempt + 1));
      }
    }
  }

  throw new Error(`[jito] ${method} failed: ${lastError}`);
}

function percentileTipKeys(percentile: number): string[] {
  if (percentile >= 0.99) return ["ema_landed_tips_99th_percentile", "landed_tips_99th_percentile"];
  if (percentile >= 0.95) return ["ema_landed_tips_95th_percentile", "landed_tips_95th_percentile"];
  if (percentile >= 0.75) return ["ema_landed_tips_75th_percentile", "landed_tips_75th_percentile"];
  return ["ema_landed_tips_50th_percentile", "landed_tips_50th_percentile"];
}

function tipValueToLamports(value: number): number {
  // Jito's public tip-floor feed reports SOL-denominated decimals, while
  // on-chain account sampling returns lamports. Accept both forms.
  return Math.round(value > 0 && value < 1 ? value * LAMPORTS_PER_SOL : value);
}

async function getLiveTipFloorLamports(percentile: number): Promise<number | null> {
  const keys = percentileTipKeys(percentile);
  let lastError = "";

  for (const url of JITO_TIP_FLOOR_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }

      const json: any = await res.json();
      const row = Array.isArray(json) ? json[0] : json;
      for (const key of keys) {
        const raw = Number(row?.[key]);
        if (Number.isFinite(raw) && raw > 0) return tipValueToLamports(raw);
      }
    } catch (err: any) {
      lastError = err.message ?? String(err);
    }
  }

  if (lastError) logger.info(`[jito] Live tip floor unavailable (${lastError})`);
  return null;
}

export async function getJitoTipAccounts(): Promise<PublicKey[]> {
  if (cachedTipAccounts) return cachedTipAccounts;

  const accounts = await jitoRpc<string[]>("getTipAccounts", []);
  if (!accounts?.length) throw new Error("[jito] getTipAccounts returned an empty list");

  cachedTipAccounts = accounts.map((a) => new PublicKey(a));
  logger.info(`[jito] Loaded ${cachedTipAccounts.length} tip account(s) from the block engine`);
  return cachedTipAccounts;
}

function extractTipAmount(
  tx: Awaited<ReturnType<Connection["getTransaction"]>>,
  tipAccount: PublicKey
): number | null {
  if (!tx?.meta) return null;
  const keys = tx.transaction.message.getAccountKeys
    ? tx.transaction.message.getAccountKeys().staticAccountKeys
    : ((tx.transaction.message as any).accountKeys as PublicKey[]);
  const idx = keys.findIndex((k) => k.toBase58() === tipAccount.toBase58());
  if (idx === -1) return null;
  const diff = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
  return diff > 0 ? diff : null;
}

async function sampleAccount(
  connection: Connection,
  account: PublicKey,
  sigsPerAccount: number
): Promise<number[]> {
  try {
    const sigs = await connection.getSignaturesForAddress(account, { limit: sigsPerAccount });
    if (!sigs.length) return [];
    const txs = await Promise.all(
      sigs.map((s) =>
        connection
          .getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
          .catch(() => null)
      )
    );
    return txs
      .map((tx) => extractTipAmount(tx, account))
      .filter((v): v is number => v !== null && v > 0);
  } catch {
    return [];
  }
}

/** Clamp a tip to the wallet-safety ceiling (if one is configured). */
export function applyTipCeiling(value: number): number {
  const rounded = Math.round(value);
  const max = config.tip.maxLamports;
  return max > 0 ? Math.min(rounded, max) : rounded;
}

/**
 * Estimate a competitive tip from live on-chain data. Falls back to the
 * configured floor when sampling or tip-account lookup is unavailable.
 */
export async function getCompetitiveTip(connection: Connection): Promise<number> {
  const { percentile, floorLamports, accountsToSample, sigsPerAccount } = config.tip;
  const pctLabel = Math.round(percentile * 100);

  try {
    const samples: number[] = [];
    const liveTipFloor = await getLiveTipFloorLamports(percentile);
    if (liveTipFloor !== null) {
      samples.push(liveTipFloor);
      logger.info(`[jito] Live tip floor p${pctLabel}=${liveTipFloor} lamports`);
    }

    logger.info(`[jito] Sampling ${accountsToSample} tip account(s) x ${sigsPerAccount} sigs for p${pctLabel} tip...`);
    const tipAccounts = await getJitoTipAccounts();
    const accountSamples = (
      await Promise.all(
        tipAccounts.slice(0, accountsToSample).map((a) =>
          sampleAccount(connection, a, sigsPerAccount)
        )
      )
    ).flat();
    samples.push(...accountSamples);

    if (!samples.length) {
      logger.info(`[jito] No tip samples available - using floor ${floorLamports} lamports`);
      return floorLamports;
    }

    samples.sort((a, b) => a - b);
    const idx = Math.min(samples.length - 1, Math.floor(samples.length * percentile));
    const target = samples[idx];
    const tip = applyTipCeiling(Math.max(floorLamports, target));
    logger.info(`[jito] Observed p${pctLabel}=${target} -> tip=${tip} (samples=${samples.length})`);
    return tip;
  } catch (err: any) {
    logger.info(`[jito] Tip estimation unavailable (${err.message}) - using floor ${floorLamports} lamports`);
    return floorLamports;
  }
}

export interface BundleSubmitResult {
  bundleId: string;
  signature: string;
  tipLamports: number;
  submitAt: number;
}

/**
 * Build, sign and submit a single-transaction Jito bundle. The caller passes
 * the full instruction list (compute budget + payload); the tip transfer is
 * appended here as the LAST instruction.
 */
export async function submitJitoBundle(
  payer: Keypair,
  blockhash: BlockhashWithExpiryBlockHeight,
  tipLamports: number,
  instructions: TransactionInstruction[],
  bundleUuid: string,
  onSigned?: (signature: string) => void | Promise<void>
): Promise<BundleSubmitResult> {
  const tipAccounts = await getJitoTipAccounts();
  const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

  const allInstructions: TransactionInstruction[] = [
    ...instructions,
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tipAccount, lamports: tipLamports }),
  ];

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: allInstructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const signature = bs58.encode(tx.signatures[0]);
  await onSigned?.(signature);
  const submitAt = Date.now();
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  const bundleId = await jitoRpc<string>("sendBundle", [[serialized], { encoding: "base64" }]);
  logger.info(`[jito] Submitted - bundleId=${bundleId ?? bundleUuid} sig=${signature.slice(0, 16)}... tip=${tipLamports}`);

  return { bundleId: bundleId ?? bundleUuid, signature, tipLamports, submitAt };
}

/** Direct RPC submission fallback when Jito bundles fail to land. */
export async function submitViaRpc(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  bundleUuid: string,
  onSigned?: (signature: string) => void | Promise<void>
): Promise<BundleSubmitResult> {
  const blockhash = await getLatestBlockhashWithRetry(connection);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = bs58.encode(tx.signatures[0]);
  await onSigned?.(signature);
  const submitAt = Date.now();

  await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
    preflightCommitment: "confirmed",
  });

  logger.info(`[rpc] Submitted - sig=${signature.slice(0, 16)}...`);
  return { bundleId: bundleUuid, signature, tipLamports: 0, submitAt };
}

/** Poll the block engine for a bundle's confirmation status. */
export async function getBundleStatus(bundleId: string): Promise<string> {
  try {
    const inflight: any = await jitoRpc("getInflightBundleStatuses", [[bundleId]]);
    const status = inflight?.value?.[0]?.status;
    const landedSlot = inflight?.value?.[0]?.landed_slot;
    if (status && status !== "Invalid") {
      return landedSlot ? `${status} (slot ${landedSlot})` : status;
    }
  } catch {}

  try {
    const result: any = await jitoRpc("getBundleStatuses", [[bundleId]]);
    const status = result?.value?.[0]?.confirmation_status;
    const slot = result?.value?.[0]?.slot;
    return status ? `${status}${slot ? ` (slot ${slot})` : ""}` : "unknown";
  } catch {
    return "unknown";
  }
}
