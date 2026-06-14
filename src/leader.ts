/**
 * src/leader.ts
 * Detects Jito-enabled leader windows from the Yellowstone slot stream.
 */

import { Connection } from "@solana/web3.js";
import { YellowstoneClient, SlotUpdate } from "./yellowstone";
import { logger } from "./logger";

const JITO_VALIDATOR_IDENTITIES = new Set<string>([
  "beefKGBWeSpHzYBHZXwp5So7wdQGX6mu4ZHCsH3uTar",
  "GBU4potq4TjsmXCUSJXbXwnkYZP8725ZEaeDrLrdQhbA",
  "9QU2QSxhb24FUX3Tu2FpczXjpK3VYrvRudywSZaM29mF",
  "HMU77m6WSL9Xew9YvVXewbXd5NeRr6YEm5k7cDCLQFm",
  "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  "dv1ZAGvdsz5hHLwWmR9KaEQbCKNRBdHQQxiNELB9jnH",
  "dv2eQHeP4RFrJZ6UeiZWoc3XTtmtZCUKqqyj1MFwdW6",
  "dv3qDFk1DTF36Z62bNvrCXe9sKATA6xvVy6A798xxAS",
  "dv4ACNkpYPcE3aKmYDqZm9G5EB3J4MRoeE7WNDRBVJB",
  "Certusm1sa411sMpV9FPqU5dXAYhmmhygvxJ23S6hJ24",
  "GkqYQysEGmuL6V2AJoNnWZUz2ZBGWhzQXsJiXm2CLMMQ",
  "DE1bawNcRJB9rVm3buyMVfr8mBEoyendZWBK5Pst5xh8",
  "CWGsCCCqMpBrFqcJSanvEFrHMPVBEVzfaB5tUBDuHvXR",
  "4pi1A3UEgUH4zBRFBaXnRFxmEGfHxLcXaHVmLnYeHFyB",
  "Fxe9vCJysTW1YRKBw9Ws6DvFKPNyBJNm7J7KhnHiRdJb",
]);

const LOOKAHEAD_SLOTS = 200;
const SKIP_DETECTION_GAP = 4;

async function fetchLeaderSchedule(
  connection: Connection,
  currentSlot: number
): Promise<Map<number, string>> {
  logger.info("[leader] Fetching leader schedule...");

  const schedule = await connection.getLeaderSchedule(currentSlot);
  if (!schedule) throw new Error("[leader] Could not fetch leader schedule");

  const epochInfo = await connection.getEpochInfo();
  const epochStartSlot = currentSlot - epochInfo.slotIndex;

  const slotToLeader = new Map<number, string>();
  for (const [validator, offsets] of Object.entries(schedule)) {
    for (const offset of offsets) {
      slotToLeader.set(epochStartSlot + offset, validator);
    }
  }

  logger.info(`[leader] Schedule loaded — ${slotToLeader.size} entries`);
  return slotToLeader;
}

export interface LeaderWindow {
  slot: number;
  validatorIdentity: string;
  isJitoEnabled: boolean;
}

export async function awaitJitoLeaderWindow(
  connection: Connection,
  yellowstone: YellowstoneClient,
  timeoutMs = 120_000
): Promise<LeaderWindow> {
  logger.info("[leader] Waiting for Jito-enabled leader window...");

  const currentSlot = yellowstone.getCurrentSlot();
  const slotToLeader = await fetchLeaderSchedule(connection, currentSlot);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      yellowstone.removeListener("slot", onSlot);
      reject(new Error(`[leader] Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSlot = (update: SlotUpdate) => {
      if (update.status !== "processed") return;

      for (let i = 0; i <= LOOKAHEAD_SLOTS; i++) {
        const leader = slotToLeader.get(update.slot + i);
        if (leader && JITO_VALIDATOR_IDENTITIES.has(leader)) {
          clearTimeout(timer);
          yellowstone.removeListener("slot", onSlot);
          logger.info(`[leader] Jito leader at slot ${update.slot + i} — ${leader.slice(0, 16)}... (${i} slots ahead)`);
          resolve({ slot: update.slot + i, validatorIdentity: leader, isJitoEnabled: true });
          return;
        }
      }
    };

    yellowstone.on("slot", onSlot);
  });
}

export interface LeaderSkipStatus {
  detected: boolean;
  lastSlot: number;
  currentSlot: number;
  gapSize: number;
}

function watchForLeaderSkip(
  yellowstone: YellowstoneClient,
  onSkip: (status: LeaderSkipStatus) => void
): () => void {
  let lastSlot = 0;

  const onSlot = (update: SlotUpdate) => {
    if (update.status !== "processed") return;
    if (lastSlot > 0 && update.slot - lastSlot > SKIP_DETECTION_GAP) {
      logger.warn(`[leader] Skip detected — gap=${update.slot - lastSlot} (${lastSlot} → ${update.slot})`);
      onSkip({ detected: true, lastSlot, currentSlot: update.slot, gapSize: update.slot - lastSlot });
    }
    lastSlot = update.slot;
  };

  yellowstone.on("slot", onSlot);
  return () => yellowstone.removeListener("slot", onSlot);
}

export async function awaitLeaderSkipWindow(
  yellowstone: YellowstoneClient,
  timeoutMs = 15_000
): Promise<LeaderSkipStatus> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      logger.warn("[leader] No skip window detected — submitting anyway");
      resolve({ detected: false, lastSlot: yellowstone.getCurrentSlot(), currentSlot: yellowstone.getCurrentSlot(), gapSize: 0 });
    }, timeoutMs);

    const cleanup = watchForLeaderSkip(yellowstone, (status) => {
      clearTimeout(timer);
      cleanup();
      resolve(status);
    });
  });
}
