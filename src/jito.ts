/**
 * src/jito.ts
 * On-chain p50 tip calculation + Jito bundle submission.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "./logger";

export const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new PublicKey("HFqU5x63VTqvB8xtHMQMNXGBo1tpwEy9LGkKxGvQxXZ"),
  new PublicKey("Cw8CFyM9FkoMi7K7Sq6fJZAGSznkfpSosYMAtGStdYCZ"),
  new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1sMaC9jnwRe"),
  new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
  new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
  new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
  new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6cv"),
];

const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf";
const MIN_TIP = 1_000;
const MAX_TIP = 0.01 * LAMPORTS_PER_SOL;
const SIGS_PER_ACCOUNT = 20;

function extractTipAmount(
  tx: Awaited<ReturnType<Connection["getTransaction"]>>,
  tipAccount: PublicKey
): number | null {
  if (!tx?.meta) return null;

  const keys = tx.transaction.message.getAccountKeys
    ? tx.transaction.message.getAccountKeys().staticAccountKeys
    : (tx.transaction.message as any).accountKeys as PublicKey[];

  const idx = keys.findIndex((k) => k.toBase58() === tipAccount.toBase58());
  if (idx === -1) return null;

  const diff = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
  return diff > 0 ? diff : null;
}

async function sampleAccount(connection: Connection, account: PublicKey): Promise<number[]> {
  try {
    const sigs = await connection.getSignaturesForAddress(account, { limit: SIGS_PER_ACCOUNT });
    if (!sigs.length) return [];

    const txs = await Promise.all(
      sigs.map((s) => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null))
    );

    return txs
      .map((tx) => extractTipAmount(tx, account))
      .filter((v): v is number => v !== null && v >= MIN_TIP);
  } catch {
    return [];
  }
}

export async function getP50TipLamports(connection: Connection): Promise<number> {
  logger.info("[jito] Sampling tip accounts on-chain...");

  const samples = (await Promise.all(JITO_TIP_ACCOUNTS.map((a) => sampleAccount(connection, a)))).flat();

  if (!samples.length) {
    logger.warn("[jito] No tip samples — using floor 5000 lamports");
    return 5_000;
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const clamped = Math.max(MIN_TIP, Math.min(p50, MAX_TIP));

  logger.info(`[jito] Tip p50=${p50} clamped=${clamped} samples=${samples.length}`);
  return clamped;
}

export interface BundleSubmitResult {
  bundleId: string;
  signature: string;
  tipLamports: number;
  submitAt: number;
}

export async function submitJitoBundle(
  payer: Keypair,
  blockhash: BlockhashWithExpiryBlockHeight,
  tipLamports: number,
  computeUnitLimit: number,
  computeUnitPrice: number,
  bundleUuid: string
): Promise<BundleSubmitResult> {
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

  const tipMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tipAccount, lamports: tipLamports }),
    ],
  }).compileToV0Message();

  const mainIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ...(computeUnitPrice > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice })] : []),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }),
  ];

  const mainMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: mainIxs,
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMsg);
  const mainTx = new VersionedTransaction(mainMsg);
  tipTx.sign([payer]);
  mainTx.sign([payer]);

  const signature = bs58.encode(mainTx.signatures[0]);
  const submitAt = Date.now();

  const res = await fetch(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[
        Buffer.from(tipTx.serialize()).toString("base64"),
        Buffer.from(mainTx.serialize()).toString("base64"),
      ]],
    }),
  });

  if (!res.ok) {
    throw new Error(`[jito] HTTP ${res.status}: ${await res.text()}`);
  }

  const json: any = await res.json();
  if (json.error) throw new Error(`[jito] RPC error: ${JSON.stringify(json.error)}`);

  const bundleId: string = json.result ?? bundleUuid;
  logger.info(`[jito] Submitted — bundleId=${bundleId} sig=${signature.slice(0, 16)}... tip=${tipLamports}`);

  return { bundleId, signature, tipLamports, submitAt };
}

export async function getBundleStatus(bundleId: string): Promise<string> {
  try {
    const res = await fetch(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBundleStatuses", params: [[bundleId]] }),
    });
    const json: any = await res.json();
    return json.result?.value?.[0]?.confirmation_status ?? "unknown";
  } catch {
    return "unknown";
  }
}
