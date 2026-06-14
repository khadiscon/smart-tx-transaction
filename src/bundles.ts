/**
 * src/bundles.ts
 * Builds all 10 bundle descriptors with fault labels.
 */

import { Connection, BlockhashWithExpiryBlockHeight } from "@solana/web3.js";
import { logger } from "./logger";

export type FaultType =
  | null
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "leader_skip_submit";

export interface BundleDescriptor {
  bundleNumber: number;
  faultType: FaultType;
  staleBlockhashSlotOffset: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  requiresSkipWindow: boolean;
  label: string;
}

export function buildBundleDescriptors(): BundleDescriptor[] {
  return [
    // 1-5: normal
    ...([1, 2, 3, 4, 5] as const).map((n) => ({
      bundleNumber: n,
      faultType: null as FaultType,
      staleBlockhashSlotOffset: 0,
      computeUnitLimit: 200_000,
      computeUnitPrice: 1_000,
      requiresSkipWindow: false,
      label: "normal",
    })),

    // 6: fee too low — zero compute unit price, validators deprioritize
    {
      bundleNumber: 6,
      faultType: "fee_too_low" as FaultType,
      staleBlockhashSlotOffset: 0,
      computeUnitLimit: 200_000,
      computeUnitPrice: 0,
      requiresSkipWindow: false,
      label: "fault:fee_too_low",
    },

    // 7: expired blockhash
    {
      bundleNumber: 7,
      faultType: "expired_blockhash" as FaultType,
      staleBlockhashSlotOffset: 200,
      computeUnitLimit: 200_000,
      computeUnitPrice: 1_000,
      requiresSkipWindow: false,
      label: "fault:expired_blockhash",
    },

    // 8: compute exceeded — limit of 1 unit always fails
    {
      bundleNumber: 8,
      faultType: "compute_exceeded" as FaultType,
      staleBlockhashSlotOffset: 0,
      computeUnitLimit: 1,
      computeUnitPrice: 1_000,
      requiresSkipWindow: false,
      label: "fault:compute_exceeded",
    },

    // 9: submit during leader skip window
    {
      bundleNumber: 9,
      faultType: "leader_skip_submit" as FaultType,
      staleBlockhashSlotOffset: 0,
      computeUnitLimit: 200_000,
      computeUnitPrice: 1_000,
      requiresSkipWindow: true,
      label: "fault:leader_skip_submit",
    },

    // 10: expired blockhash again
    {
      bundleNumber: 10,
      faultType: "expired_blockhash" as FaultType,
      staleBlockhashSlotOffset: 200,
      computeUnitLimit: 200_000,
      computeUnitPrice: 1_000,
      requiresSkipWindow: false,
      label: "fault:expired_blockhash",
    },
  ];
}

export async function fetchStaleBlockhash(
  connection: Connection,
  slotsAgo: number
): Promise<BlockhashWithExpiryBlockHeight> {
  const currentSlot = await connection.getSlot("processed");
  const targetSlot = Math.max(0, currentSlot - slotsAgo);

  logger.info(`[bundles] Fetching stale blockhash ~${slotsAgo} slots ago (slot ${targetSlot})`);

  let slot = targetSlot;
  for (let i = 0; i < 20; i++) {
    try {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "none",
        rewards: false,
      });
      if (block) {
        logger.info(`[bundles] Stale blockhash at slot ${slot}: ${block.blockhash.slice(0, 16)}...`);
        return {
          blockhash: block.blockhash,
          lastValidBlockHeight: block.blockHeight ?? targetSlot + 150,
        };
      }
    } catch {}
    slot = Math.max(0, slot - 1);
  }

  logger.warn("[bundles] Could not find real stale block — using zeroed hash");
  return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 };
}
