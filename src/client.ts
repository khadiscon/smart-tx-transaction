/**
 * src/client.ts
 * SmartTxClient - the reusable core of the stack.
 *
 * Hand it a set of instructions and it will: estimate a competitive tip from
 * live on-chain data, build and sign a single-transaction Jito bundle, submit
 * it, track the lifecycle (submitted -> processed -> confirmed -> finalized)
 * over the Yellowstone stream, and on failure consult the AI agent for one
 * corrective action and retry. It has no notion of "10 bundles", never exits
 * the process, and never injects faults - that lives only in the harness.
 */

import {
  Connection,
  Keypair,
  ComputeBudgetProgram,
  TransactionInstruction,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
import { YellowstoneClient, TxConfirmation } from "./yellowstone";
import {
  submitJitoBundle,
  submitViaRpc,
  getCompetitiveTip,
  applyTipCeiling,
  getBundleStatus,
  BundleSubmitResult,
} from "./jito";
import { awaitJitoLeaderWindow } from "./leader";
import { callAgent, AgentFailureContext } from "./agent";
import { config } from "./config";
import { logger, writeLifecycleEntry, LifecycleEntry, BundleStatus, AgentAction } from "./logger";

export interface SubmitOptions {
  /** Compute unit limit for the transaction. Default 200_000. */
  computeUnitLimit?: number;
  /** Compute unit price in micro-lamports. Default 1_000. 0 omits the instruction. */
  computeUnitPrice?: number;
  /** Max agent-driven retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Human-readable label for logs and the summary. */
  label?: string;
  /** Honest record of any deliberate fault-injection condition (set by the harness). */
  faultInjected?: string | null;
  /** Optional blockhash override for the FIRST attempt only (fault-injection testing). */
  initialBlockhash?: BlockhashWithExpiryBlockHeight;
}

export interface BundleOutcome {
  bundleId: string;
  signature: string | null;
  tipLamports: number;
  faultInjected: string | null;
  status: BundleStatus;
  failureType: string | null;
  submitToConfirmedMs: number | null;
  retryCount: number;
  agentDecision?: AgentAction;
  label: string;
}

const DEFAULT_MAX_RETRIES = 1;
const CONFIRM_TIMEOUT_MS = 30_000;
const LEADER_WAIT_MS = 75_000;
const MIN_SUBMIT_LEADER_LEAD_SLOTS = 80;
const MAX_SUBMIT_LEADER_LEAD_SLOTS = 120;
const RPC_FALLBACK_CU_PRICE = 100_000;
const ENABLE_RPC_FALLBACK = process.env.ENABLE_RPC_FALLBACK === "true";

export class SmartTxClient {
  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
    private readonly yellowstone: YellowstoneClient
  ) {}

  async submit(
    userInstructions: TransactionInstruction[],
    opts: SubmitOptions = {}
  ): Promise<BundleOutcome> {
    const bundleUuid = uuidv4();
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const cuLimit = opts.computeUnitLimit ?? 200_000;
    const cuPrice = opts.computeUnitPrice ?? 1_000;
    const faultInjected = opts.faultInjected ?? null;
    const label = opts.label ?? "submit";

    let tipLamports = config.tip.floorLamports;
    try {
      tipLamports = await getCompetitiveTip(this.connection);
    } catch {
      logger.info(`[client] Using floor tip ${tipLamports} lamports`);
    }
    let retryCount = 0;
    let agentDecision: AgentAction | undefined;
    let agentReasoning: string | undefined;
    let finalStatus: BundleStatus = "failed";
    let finalSignature: string | null = null;
    let finalFailureType: string | null = null;
    let submitToConfirmedMs: number | null = null;

    const submitAt = Date.now();
    const slots: LifecycleEntry["slots"] = {};
    const timestamps: LifecycleEntry["timestamps"] = { submitAt };

    logger.info(`\n--- ${label} [${faultInjected ?? "primary-path"}] ---`);

    while (retryCount <= maxRetries) {
      // Resolve the blockhash for this attempt.
      let blockhash: BlockhashWithExpiryBlockHeight | undefined = undefined;

      let submitResult: BundleSubmitResult | null = null;
      let submitError: string | null = null;

      try {
        await this.yellowstone.waitForHealthyStream(60_000);

        const instructions: TransactionInstruction[] = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
          ...(cuPrice > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice })] : []),
          ...userInstructions,
        ];

        let targetLeaderSlot: number | null = null;
        if (!faultInjected) {
          const window = await awaitJitoLeaderWindow(this.connection, this.yellowstone, LEADER_WAIT_MS, {
            minLeadSlots: MIN_SUBMIT_LEADER_LEAD_SLOTS,
            maxLeadSlots: MAX_SUBMIT_LEADER_LEAD_SLOTS,
          }).catch((err) => {
            logger.warn(`[client] Leader wait: ${err.message} - submitting anyway`);
            return null;
          });
          targetLeaderSlot = window?.slot ?? null;
        }

        if (retryCount === 0 && opts.initialBlockhash) {
          blockhash = opts.initialBlockhash;
        } else {
          blockhash = await getBlockhashWithRetry(this.connection);
          if (agentDecision === "refresh_blockhash") {
            const fresh = await getCompetitiveTip(this.connection).catch(() => tipLamports);
            tipLamports = Math.max(fresh, tipLamports);
            logger.info(`[client] Fresh blockhash + recalculated tip (${tipLamports}) per agent`);
          }
        }

        if (targetLeaderSlot !== null) {
          const currentSlot = Math.max(
            this.yellowstone.getCurrentSlot(),
            await this.connection.getSlot("processed").catch(() => 0)
          );
          const lead = targetLeaderSlot - currentSlot;
          if (lead < 4) {
            logger.warn(`[client] Target Jito leader slot ${targetLeaderSlot} is stale after blockhash fetch (lead=${lead}); selecting a new window`);
            await awaitJitoLeaderWindow(this.connection, this.yellowstone, LEADER_WAIT_MS, {
              minLeadSlots: MIN_SUBMIT_LEADER_LEAD_SLOTS,
              maxLeadSlots: MAX_SUBMIT_LEADER_LEAD_SLOTS,
            }).catch((err) => logger.warn(`[client] Second leader wait: ${err.message} - submitting anyway`));
          }
        }

        submitResult = await submitJitoBundle(
          this.payer,
          blockhash,
          tipLamports,
          instructions,
          bundleUuid,
          (signature) => this.yellowstone.subscribeToTransaction(signature)
        );
        finalSignature = submitResult.signature;
        timestamps.submitAt = submitResult.submitAt;
        slots.submitted = this.yellowstone.getCurrentSlot();
        logger.info(`[client] Submitted - sig=${submitResult.signature.slice(0, 20)}...`);
        getBundleStatus(submitResult.bundleId)
          .then((s) => logger.info(`[client] Jito bundle status: ${s}`))
          .catch(() => {});
      } catch (err: any) {
        submitError = err.message;
        logger.error(`[client] Submit failed: ${submitError}`);
      }

      let confirmError: string | null = null;

      if (submitResult && !submitError) {
        try {
          const processed = await waitForConfirmation(
            this.connection,
            this.yellowstone,
            submitResult.signature,
            "processed",
            CONFIRM_TIMEOUT_MS,
            submitResult.bundleId
          );
          slots.processed = processed.slot;
          timestamps.processedAt = Date.now();

          const confirmed = await waitForConfirmation(
            this.connection,
            this.yellowstone,
            submitResult.signature,
            "confirmed",
            CONFIRM_TIMEOUT_MS,
            submitResult.bundleId
          );
          slots.confirmed = confirmed.slot;
          timestamps.confirmedAt = Date.now();

          // Track finalized asynchronously - don't block the loop.
          waitForConfirmation(this.connection, this.yellowstone, submitResult.signature, "finalized", 120_000)
            .then((f) => {
              slots.finalized = f.slot;
              timestamps.finalizedAt = Date.now();
            })
            .catch(() => {});

          submitToConfirmedMs = timestamps.confirmedAt - (timestamps.submitAt ?? submitAt);
          finalStatus = retryCount > 0 ? "retried" : "success";
          finalFailureType = null;
          logger.info(`[client] Confirmed at slot ${slots.confirmed} (${submitToConfirmedMs}ms)`);
          break;
        } catch (err: any) {
          confirmError = err.message;
          logger.warn(`[client] Confirmation failed: ${confirmError}`);
        }
      }

      const rawError = submitError ?? confirmError ?? "unknown_error";
      finalFailureType = classifyFailure(rawError);

      if (retryCount >= maxRetries) {
        finalStatus = "failed";
        logger.warn(`[client] ${label} exhausted retries`);
        break;
      }

      const ctx: AgentFailureContext = {
        bundleId: bundleUuid,
        faultType: faultInjected,
        rawError,
        retryCount,
        slotContext: {
          currentSlot: this.yellowstone.getCurrentSlot(),
          submitSlot: slots.processed,
        },
        tipLamports,
        blockhash: blockhash?.blockhash,
      };

      const decision = await callAgent(ctx);
      agentDecision = decision.action;
      // Record the model's actual reasoning, or the real system-failure reason -
      // never a generic canned string.
      agentReasoning = decision.isSystemFailure
        ? `[agent unavailable] ${decision.reasoning}`
        : decision.reasoning;
      logger.info(`[client] Agent -> ${agentDecision}: ${(agentReasoning ?? "").slice(0, 140)}`);

      if (agentDecision === "abort") {
        finalStatus = "aborted";
        break;
      }

      if (agentDecision === "increase_tip") {
        const fresh = await getCompetitiveTip(this.connection).catch(() => tipLamports);
        tipLamports = applyTipCeiling(Math.max(fresh, tipLamports) * 1.5);
        logger.info(`[client] Tip raised -> ${tipLamports} lamports`);
      }

      if (agentDecision === "wait_next_leader") {
        await awaitJitoLeaderWindow(this.connection, this.yellowstone, LEADER_WAIT_MS, {
          minLeadSlots: MIN_SUBMIT_LEADER_LEAD_SLOTS,
          maxLeadSlots: MAX_SUBMIT_LEADER_LEAD_SLOTS,
        }).catch(() =>
          logger.warn("[client] Leader wait timed out - retrying anyway")
        );
      }

      retryCount++;
      logger.info(`[client] Retry attempt ${retryCount + 1}...`);
      await sleep(2_000); // avoid hammering the rate-limited public endpoint
    }

    if (finalStatus === "failed" && !faultInjected && !ENABLE_RPC_FALLBACK) {
      logger.info("[client] Jito exhausted — recording failed Jito outcome (set ENABLE_RPC_FALLBACK=true to submit RPC fallback)");
    }

    if (finalStatus === "failed" && !faultInjected && ENABLE_RPC_FALLBACK) {
      logger.info("[client] Jito exhausted — last-resort RPC submission");
      const rpcInstructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: RPC_FALLBACK_CU_PRICE }),
        ...userInstructions,
      ];
      try {
        const rpcResult = await submitViaRpc(
          this.connection,
          this.payer,
          rpcInstructions,
          bundleUuid,
          (signature) => this.yellowstone.subscribeToTransaction(signature)
        );
        finalSignature = rpcResult.signature;
        timestamps.submitAt = rpcResult.submitAt;
        slots.submitted = this.yellowstone.getCurrentSlot();

        const processed = await waitForConfirmation(
          this.connection, this.yellowstone, rpcResult.signature, "processed", CONFIRM_TIMEOUT_MS
        );
        slots.processed = processed.slot;
        timestamps.processedAt = Date.now();

        const confirmed = await waitForConfirmation(
          this.connection, this.yellowstone, rpcResult.signature, "confirmed", CONFIRM_TIMEOUT_MS
        );
        slots.confirmed = confirmed.slot;
        timestamps.confirmedAt = Date.now();
        submitToConfirmedMs = timestamps.confirmedAt - (timestamps.submitAt ?? submitAt);
        finalStatus = "retried";
        finalFailureType = null;
        logger.info(`[client] RPC last-resort confirmed at slot ${slots.confirmed} (${submitToConfirmedMs}ms)`);
      } catch (err: any) {
        finalFailureType = classifyFailure(err.message);
        logger.warn(`[client] RPC last-resort failed: ${err.message}`);
      }
    }

    writeLifecycleEntry({
      bundleId: bundleUuid,
      signature: finalSignature,
      tipLamports,
      faultInjected,
      status: finalStatus,
      failureType: finalFailureType,
      slots,
      timestamps,
      latency: buildLatency(timestamps, submitToConfirmedMs),
      agentDecision,
      agentReasoning,
      retryCount,
    });

    return {
      bundleId: bundleUuid,
      signature: finalSignature,
      tipLamports,
      faultInjected,
      status: finalStatus,
      failureType: finalFailureType,
      submitToConfirmedMs,
      retryCount,
      agentDecision,
      label,
    };
  }
}

function buildLatency(
  timestamps: LifecycleEntry["timestamps"],
  submitToConfirmedMs: number | null
): LifecycleEntry["latency"] {
  const latency: LifecycleEntry["latency"] = {};
  if (timestamps.submitAt && timestamps.processedAt)
    latency.submitToProcessed = timestamps.processedAt - timestamps.submitAt;
  if (timestamps.processedAt && timestamps.confirmedAt)
    latency.processedToConfirmed = timestamps.confirmedAt - timestamps.processedAt;
  if (timestamps.confirmedAt && timestamps.finalizedAt)
    latency.confirmedToFinalized = timestamps.finalizedAt - timestamps.confirmedAt;
  if (submitToConfirmedMs !== null) latency.submitToConfirmed = submitToConfirmedMs;
  return latency;
}

/** Map a raw error string to a failure category, purely from the real error. */
export function classifyFailure(rawError: string): string {
  const e = rawError.toLowerCase();
  if (e.includes("blockhash") || e.includes("block hash")) return "expired_blockhash";
  if (e.includes("compute") || e.includes("budget")) return "compute_exceeded";
  if (e.includes("write lock") || e.includes("tip account")) return "tip_account_not_write_locked";
  if (e.includes("fee") || e.includes("priorit")) return "fee_too_low";
  if (e.includes("skip") || e.includes("leader")) return "leader_skip";
  if (e.includes("yellowstone") || e.includes("fresh slot") || e.includes("stream")) return "yellowstone_unavailable";
  if (e.includes("timeout")) return "confirmation_timeout";
  if (e.includes("bundle")) return "bundle_dropped";
  return "unknown";
}

async function waitForConfirmation(
  connection: Connection,
  yellowstone: YellowstoneClient,
  signature: string,
  targetCommitment: "processed" | "confirmed" | "finalized",
  timeoutMs: number,
  bundleId?: string
): Promise<TxConfirmation> {
  const rank = { processed: 0, confirmed: 1, finalized: 2 };
  const deadline = Date.now() + timeoutMs;
  const streamBudget = Math.floor(timeoutMs * 0.6);
  let lastBundleCheckAt = 0;
  let lastBundleStatus = "";

  if (yellowstone.isConnected()) {
    try {
      const streamConf = await yellowstone.waitForConfirmation(signature, targetCommitment, streamBudget);
      logger.info(`[client] Confirmed via Yellowstone stream (${streamConf.status})`);
      return streamConf;
    } catch (streamErr: any) {
      logger.warn(`[client] Stream confirmation pending (${streamErr.message}) - checking RPC`);
    }
  }

  while (Date.now() < deadline) {
    if (bundleId && Date.now() - lastBundleCheckAt > 5_000) {
      lastBundleCheckAt = Date.now();
      const bundleStatus = await getBundleStatus(bundleId).catch(() => "unknown");
      if (bundleStatus !== "unknown" && bundleStatus !== lastBundleStatus) {
        logger.info(`[client] Jito bundle status during confirmation: ${bundleStatus}`);
        lastBundleStatus = bundleStatus;
      }
      if (/failed/i.test(bundleStatus)) {
        throw new Error(`[client] Jito bundle failed: ${bundleStatus}`);
      }
    }

    const statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses?.value?.[0];
    if (status?.confirmationStatus) {
      const conf = status.confirmationStatus as TxConfirmation["status"];
      if (rank[conf] >= rank[targetCommitment]) {
        logger.info(`[client] Confirmed via RPC backup (${conf})`);
        return {
          signature,
          slot: status.slot ?? yellowstone.getCurrentSlot(),
          status: conf,
          err: status.err ? JSON.stringify(status.err) : null,
        };
      }
    }
    await sleep(2_000);
  }

  throw new Error(`[client] Timeout (${timeoutMs}ms) for ${signature.slice(0, 16)}...`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * getLatestBlockhash over a public/shared RPC occasionally hits a transient
 * "fetch failed". Without a retry here, that single blip used to crash the
 * entire benchmark mid-run instead of just failing the current bundle.
 */
async function getBlockhashWithRetry(
  connection: Connection,
  attempts = 3
): Promise<BlockhashWithExpiryBlockHeight> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (err: any) {
      lastErr = err;
      logger.warn(`[client] getLatestBlockhash attempt ${i + 1}/${attempts} failed: ${err.message}`);
      if (i < attempts - 1) await sleep(1_000 * (i + 1));
    }
  }
  throw new Error(`[client] getLatestBlockhash failed after ${attempts} attempts: ${lastErr?.message}`);
}
