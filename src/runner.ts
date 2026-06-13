/**
 * src/runner.ts
 * Main orchestration loop — submits 10 bundles, tracks lifecycle, calls agent on failure.
 */

import {
  Connection,
  Keypair,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
import { YellowstoneClient } from "./yellowstone";
import { buildBundleDescriptors, fetchStaleBlockhash, BundleDescriptor } from "./bundles";
import { submitJitoBundle, getP50TipLamports, BundleSubmitResult } from "./jito";
import { awaitLeaderSkipWindow, awaitJitoLeaderWindow } from "./leader";
import { callHunterAlpha, describeAction, AgentFailureContext } from "./agent";
import { logger, writeLifecycleEntry, LifecycleEntry, BundleStatus, AgentAction } from "./logger";

export interface BundleResult {
  bundleNumber: number;
  bundleId: string;
  signature: string | null;
  tipLamports: number;
  faultType: string | null;
  status: BundleStatus;
  failureType: string | null;
  submitToConfirmedMs: number | null;
  retryCount: number;
  agentDecision?: AgentAction;
}

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  retried: number;
  aborted: number;
  avgTipLamports: number;
  avgSubmitToConfirmedMs: number;
  failureBreakdown: Record<string, number>;
  results: BundleResult[];
}

const MAX_RETRIES = 2;
const CONFIRM_TIMEOUT_MS = 45_000;

async function getFreshBlockhash(connection: Connection): Promise<BlockhashWithExpiryBlockHeight> {
  return connection.getLatestBlockhash("confirmed");
}

export async function runAllBundles(
  connection: Connection,
  payer: Keypair,
  yellowstone: YellowstoneClient
): Promise<RunSummary> {
  const descriptors = buildBundleDescriptors();
  const results: BundleResult[] = [];

  let baseTip = await getP50TipLamports(connection);

  for (const descriptor of descriptors) {
    const result = await runSingleBundle(connection, payer, yellowstone, descriptor, baseTip);
    results.push(result);
    await sleep(500);
  }

  return computeSummary(results);
}

async function runSingleBundle(
  connection: Connection,
  payer: Keypair,
  yellowstone: YellowstoneClient,
  descriptor: BundleDescriptor,
  initialTip: number
): Promise<BundleResult> {
  const bundleUuid = uuidv4();
  let tipLamports = initialTip;
  let retryCount = 0;
  let agentDecision: AgentAction | undefined;
  let finalStatus: BundleStatus = "failed";
  let finalSignature: string | null = null;
  let finalFailureType: string | null = null;
  let submitToConfirmedMs: number | null = null;

  const submitAt = Date.now();
  const slots: LifecycleEntry["slots"] = {};
  const timestamps: LifecycleEntry["timestamps"] = { submitAt };

  logger.info(`\n━━━ Bundle #${descriptor.bundleNumber} [${descriptor.label}] ━━━`);

  if (descriptor.requiresSkipWindow) {
    logger.info("[runner] Waiting for leader skip window...");
    const skip = await awaitLeaderSkipWindow(yellowstone, 15_000);
    if (skip.detected) {
      logger.info(`[runner] Skip detected (gap=${skip.gapSize}) — submitting now`);
    }
  }

  while (retryCount <= MAX_RETRIES) {
    // Resolve blockhash
    let blockhash: BlockhashWithExpiryBlockHeight;
    if (agentDecision === "refresh_blockhash") {
      blockhash = await getFreshBlockhash(connection);
      logger.info("[runner] Fresh blockhash fetched per agent");
    } else if (descriptor.staleBlockhashSlotOffset > 0) {
      blockhash = await fetchStaleBlockhash(connection, descriptor.staleBlockhashSlotOffset);
    } else {
      blockhash = await getFreshBlockhash(connection);
    }

    let submitResult: BundleSubmitResult | null = null;
    let submitError: string | null = null;

    try {
      submitResult = await submitJitoBundle(
        payer,
        blockhash,
        tipLamports,
        descriptor.computeUnitLimit,
        descriptor.computeUnitPrice,
        bundleUuid
      );
      finalSignature = submitResult.signature;
      timestamps.submitAt = submitResult.submitAt;
      slots.submitted = yellowstone.getCurrentSlot();
      logger.info(`[runner] Submitted — sig=${submitResult.signature.slice(0, 20)}...`);
    } catch (err: any) {
      submitError = err.message;
      logger.error(`[runner] Submit failed: ${submitError}`);
    }

    let confirmError: string | null = null;

    if (submitResult && !submitError) {
      try {
        const processed = await yellowstone.waitForConfirmation(
          submitResult.signature, "processed", CONFIRM_TIMEOUT_MS
        );
        slots.processed = processed.slot;
        timestamps.processedAt = Date.now();

        const confirmed = await yellowstone.waitForConfirmation(
          submitResult.signature, "confirmed", CONFIRM_TIMEOUT_MS
        );
        slots.confirmed = confirmed.slot;
        timestamps.confirmedAt = Date.now();

        // track finalized async — don't block
        yellowstone.waitForConfirmation(submitResult.signature, "finalized", 120_000)
          .then((f) => { slots.finalized = f.slot; timestamps.finalizedAt = Date.now(); })
          .catch(() => {});

        submitToConfirmedMs = timestamps.confirmedAt - (timestamps.submitAt ?? submitAt);
        finalStatus = retryCount > 0 ? "retried" : "success";
        finalFailureType = null;

        logger.info(`[runner] ✓ Confirmed at slot ${slots.confirmed} (${submitToConfirmedMs}ms)`);
        break;
      } catch (err: any) {
        confirmError = err.message;
        logger.warn(`[runner] Confirmation failed: ${confirmError}`);
      }
    }

    const rawError = submitError ?? confirmError ?? "unknown_error";
    finalFailureType = classifyFailure(rawError, descriptor);

    if (retryCount < MAX_RETRIES) {
      const ctx: AgentFailureContext = {
        bundleId: bundleUuid,
        bundleNumber: descriptor.bundleNumber,
        faultType: descriptor.faultType,
        rawError,
        retryCount,
        slotContext: {
          currentSlot: yellowstone.getCurrentSlot(),
          submitSlot: slots.processed,
          isJitoEnabled: true,
          skipDetected: descriptor.requiresSkipWindow,
        },
        tipLamports,
        blockhash: blockhash?.blockhash,
      };

      agentDecision = await callHunterAlpha(ctx);
      logger.info(`[runner] Agent: ${agentDecision} — ${describeAction(agentDecision)}`);

      if (agentDecision === "abort") {
        finalStatus = "aborted";
        break;
      }

      if (agentDecision === "increase_tip") {
        // Re-fetch p50 and take the higher of fresh p50 vs current, then multiply
        const freshP50 = await getP50TipLamports(connection);
        tipLamports = Math.round(Math.max(freshP50, tipLamports) * 1.5);
        logger.info(`[runner] Tip recalculated → ${tipLamports} lamports`);
      }

      if (agentDecision === "wait_next_leader") {
        await awaitJitoLeaderWindow(connection, yellowstone, 60_000)
          .catch(() => logger.warn("[runner] Leader wait timed out — retrying anyway"));
      }

      retryCount++;
      logger.info(`[runner] Retry attempt ${retryCount + 1}...`);
    } else {
      finalStatus = "failed";
      logger.warn(`[runner] Bundle #${descriptor.bundleNumber} exhausted retries`);
      break;
    }
  }

  const latency: LifecycleEntry["latency"] = {};
  if (timestamps.submitAt && timestamps.processedAt)
    latency.submitToProcessed = timestamps.processedAt - timestamps.submitAt;
  if (timestamps.processedAt && timestamps.confirmedAt)
    latency.processedToConfirmed = timestamps.confirmedAt - timestamps.processedAt;
  if (timestamps.confirmedAt && timestamps.finalizedAt)
    latency.confirmedToFinalized = timestamps.finalizedAt - timestamps.confirmedAt;
  if (submitToConfirmedMs !== null)
    latency.submitToConfirmed = submitToConfirmedMs;

  writeLifecycleEntry({
    bundleId: bundleUuid,
    signature: finalSignature,
    tipLamports,
    faultInjected: descriptor.faultType,
    status: finalStatus,
    failureType: finalFailureType,
    slots,
    timestamps,
    latency,
    agentDecision,
    agentReasoning: agentDecision ? describeAction(agentDecision) : undefined,
    retryCount,
  });

  return {
    bundleNumber: descriptor.bundleNumber,
    bundleId: bundleUuid,
    signature: finalSignature,
    tipLamports,
    faultType: descriptor.faultType,
    status: finalStatus,
    failureType: finalFailureType,
    submitToConfirmedMs,
    retryCount,
    agentDecision,
  };
}

function classifyFailure(rawError: string, descriptor: BundleDescriptor): string {
  const e = rawError.toLowerCase();
  if (descriptor.faultType === "expired_blockhash" || e.includes("blockhash") || e.includes("block hash"))
    return "expired_blockhash";
  if (descriptor.faultType === "fee_too_low" || e.includes("fee") || e.includes("priorit"))
    return "fee_too_low";
  if (descriptor.faultType === "compute_exceeded" || e.includes("compute") || e.includes("budget"))
    return "compute_exceeded";
  if (descriptor.faultType === "leader_skip_submit" || e.includes("skip") || e.includes("leader"))
    return "leader_skip";
  if (e.includes("timeout")) return "confirmation_timeout";
  if (e.includes("bundle")) return "bundle_dropped";
  return "unknown";
}

function computeSummary(results: BundleResult[]): RunSummary {
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const retried = results.filter((r) => r.status === "retried").length;
  const aborted = results.filter((r) => r.status === "aborted").length;

  const avgTip = results.reduce((a, b) => a + b.tipLamports, 0) / results.length;

  const latencies = results
    .filter((r) => r.submitToConfirmedMs !== null)
    .map((r) => r.submitToConfirmedMs as number);

  const avgLatency = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;

  const failureBreakdown: Record<string, number> = {};
  for (const r of results) {
    if (r.failureType) {
      failureBreakdown[r.failureType] = (failureBreakdown[r.failureType] ?? 0) + 1;
    }
  }

  return {
    total: results.length,
    succeeded,
    failed,
    retried,
    aborted,
    avgTipLamports: Math.round(avgTip),
    avgSubmitToConfirmedMs: Math.round(avgLatency),
    failureBreakdown,
    results,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
