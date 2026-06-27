/**
 * src/bundles.ts
 * Fault-injection utilities used ONLY by the benchmark harness in --adverse
 * mode. The core stack (client.ts) has no knowledge of these profiles. They
 * exist so we can deliberately exercise the failure/retry paths against real
 * infrastructure (the resulting rejections are genuine on-chain events), and
 * every fault-injection submission is labeled as such in the lifecycle log.
 */

import { Connection, BlockhashWithExpiryBlockHeight } from "@solana/web3.js";
import { logger } from "./logger";

export type FaultInjectionKind =
  | "expired_blockhash"
  | "compute_exceeded"
  | "leader_skip";

export interface FaultInjectionProfile {
  label: string;
  kind: FaultInjectionKind;
  description: string;
  staleBlockhashSlotOffset?: number;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  requireSkipWindow?: boolean;
  /** Whether this profile dependably produces a failure on a healthy mainnet. */
  reliable: boolean;
}

/**
 * Fault-injection profiles for --adverse mode. Only the `reliable` ones run by default.
 * The unreliable ones are documented but require --include-unreliable, because
 * on a healthy network they may simply succeed (and that is honest to admit).
 */
export const FAULT_INJECTION_PROFILES: FaultInjectionProfile[] = [
  {
    label: "fault-injection:expired-blockhash",
    kind: "expired_blockhash",
    staleBlockhashSlotOffset: 200,
    reliable: true,
    description:
      "Submits with a ~200-slot-old blockhash so the engine rejects it; exercises agent refresh_blockhash recovery.",
  },
  {
    label: "fault-injection:compute-budget-exceeded",
    kind: "compute_exceeded",
    computeUnitLimit: 1,
    reliable: true,
    description:
      "Caps the compute budget at 1 CU so the transaction cannot execute; exercises failure classification.",
  },
  {
    label: "fault-injection:leader-skip-window",
    kind: "leader_skip",
    requireSkipWindow: true,
    reliable: false,
    description:
      "Submits into a detected leader-skip gap. Unreliable; depends entirely on live network conditions.",
  },
];

/**
 * Fetch a real (but stale) blockhash from `slotsAgo` slots back, used only for
 * the expired-blockhash fault-injection profile. Throws rather than returning a
 * degenerate all-zero blockhash, which would only produce confusing downstream
 * errors.
 */
export async function fetchStaleBlockhash(
  connection: Connection,
  slotsAgo: number
): Promise<BlockhashWithExpiryBlockHeight> {
  const currentSlot = await connection.getSlot("processed");
  const targetSlot = Math.max(0, currentSlot - slotsAgo);

  logger.info(`[fault-injection] Fetching stale blockhash ~${slotsAgo} slots ago (slot ${targetSlot})`);

  let slot = targetSlot;
  for (let i = 0; i < 20; i++) {
    try {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "none",
        rewards: false,
      });
      if (block) {
        logger.info(`[fault-injection] Stale blockhash at slot ${slot}: ${block.blockhash.slice(0, 16)}...`);
        return { blockhash: block.blockhash, lastValidBlockHeight: slot + 150 };
      }
    } catch {}
    slot = Math.max(0, slot - 1);
  }

  throw new Error(
    `[fault-injection] Could not fetch a real block within 20 slots of ${targetSlot} ` +
    `for stale-blockhash injection - aborting rather than submitting a zeroed hash.`
  );
}
