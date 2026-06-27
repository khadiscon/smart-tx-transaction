/**
 * src/runner.ts
 * Benchmark harness - drives the SmartTxClient through a configurable number of
 * real submissions to produce a lifecycle log. Fault-injection cases are
 * clearly labeled; the core client has no knowledge of them.
 */

import { Connection, Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { YellowstoneClient } from "./yellowstone";
import { SmartTxClient, SubmitOptions, BundleOutcome } from "./client";
import { FAULT_INJECTION_PROFILES, FaultInjectionProfile, fetchStaleBlockhash } from "./bundles";
import { awaitLeaderSkipWindow } from "./leader";
import { logger } from "./logger";

export interface BenchmarkOptions {
  primarySubmissionCount: number;
  primaryStartIndex?: number;
  faultInjection: boolean;
  includeUnreliableFaults?: boolean;
  onlyFaultLabels?: string[];
  skipFaultLabels?: string[];
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
  results: BundleOutcome[];
}

/**
 * Minimal demo payload: a zero-lamport self-transfer (a harmless liveness
 * no-op). Replace this with your real instructions in production - the client
 * accepts any instruction list.
 */
function demoPayload(payer: Keypair): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  ];
}

export async function runBenchmark(
  connection: Connection,
  payer: Keypair,
  yellowstone: YellowstoneClient,
  opts: BenchmarkOptions
): Promise<RunSummary> {
  const client = new SmartTxClient(connection, payer, yellowstone);
  const results: BundleOutcome[] = [];

  // Primary submissions - the real product path.
  const primaryStartIndex = opts.primaryStartIndex ?? 1;
  for (let i = 0; i < opts.primarySubmissionCount; i++) {
    const submissionNumber = primaryStartIndex + i;
    const label = `submission-${String(submissionNumber).padStart(3, "0")}`;
    logger.info(`\n[benchmark] ${label} (${i + 1}/${opts.primarySubmissionCount})`);
    results.push(await client.submit(demoPayload(payer), { label }));
    await sleep(1_500);
  }

  // Fault-injection submissions - opt-in, honestly labeled failure-path exercises.
  if (opts.faultInjection) {
    const onlyFaultLabels = new Set(opts.onlyFaultLabels ?? []);
    const skipFaultLabels = new Set(opts.skipFaultLabels ?? []);
    const profiles = FAULT_INJECTION_PROFILES.filter((p) =>
      (p.reliable || opts.includeUnreliableFaults) &&
      (onlyFaultLabels.size === 0 || onlyFaultLabels.has(p.label)) &&
      !skipFaultLabels.has(p.label)
    );
    for (const profile of profiles) {
      logger.info(`\n[benchmark] ${profile.label}: ${profile.description}`);
      results.push(await runFaultInjection(client, connection, payer, yellowstone, profile));
      await sleep(1_500);
    }
  }

  return computeSummary(results);
}

async function runFaultInjection(
  client: SmartTxClient,
  connection: Connection,
  payer: Keypair,
  yellowstone: YellowstoneClient,
  profile: FaultInjectionProfile
): Promise<BundleOutcome> {
  const submitOptions: SubmitOptions = { label: profile.label, faultInjected: profile.label };

  if (profile.computeUnitLimit !== undefined) submitOptions.computeUnitLimit = profile.computeUnitLimit;
  if (profile.computeUnitPrice !== undefined) submitOptions.computeUnitPrice = profile.computeUnitPrice;

  if (profile.staleBlockhashSlotOffset) {
    try {
      submitOptions.initialBlockhash = await fetchStaleBlockhash(connection, profile.staleBlockhashSlotOffset);
    } catch (err: any) {
      logger.warn(`[benchmark] ${profile.label}: ${err.message} - skipping stale-hash injection`);
    }
  }

  if (profile.requireSkipWindow) {
    logger.info(`[benchmark] ${profile.label}: waiting for a leader-skip window...`);
    const skip = await awaitLeaderSkipWindow(yellowstone, 15_000);
    if (skip.detected) logger.info(`[benchmark] Skip detected (gap=${skip.gapSize})`);
  }

  return client.submit(demoPayload(payer), submitOptions);
}

function computeSummary(results: BundleOutcome[]): RunSummary {
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const retried = results.filter((r) => r.status === "retried").length;
  const aborted = results.filter((r) => r.status === "aborted").length;

  const avgTip = results.length
    ? results.reduce((a, b) => a + b.tipLamports, 0) / results.length
    : 0;

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
