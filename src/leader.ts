/**
 * src/leader.ts
 * Detects Jito-enabled leader windows from the Yellowstone slot stream.
 */

import { Connection } from "@solana/web3.js";
import { YellowstoneClient, SlotUpdate } from "./yellowstone";
import { logger } from "./logger";

const JITO_VALIDATORS_API = "https://kobe.mainnet.jito.network/api/v1/validators";
const LOOKAHEAD_SLOTS = 200;
const SKIP_DETECTION_GAP = 4;

let cachedJitoIdentities: Set<string> | null = null;
let cacheFetchedAt = 0;
let cachedSchedule: { map: Map<number, string>; fetchedAt: number; epochStart: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1_000;
const SCHEDULE_TTL_MS = 60 * 1_000;

/** Fetch live Jito-enabled validator identity accounts from the Kobe API. */
export async function getJitoValidatorIdentities(): Promise<Set<string>> {
  if (cachedJitoIdentities && Date.now() - cacheFetchedAt < CACHE_TTL_MS) {
    return cachedJitoIdentities;
  }

  const res = await fetch(JITO_VALIDATORS_API);
  if (!res.ok) throw new Error(`[leader] Jito validators API HTTP ${res.status}`);

  const json: any = await res.json();
  const validators: any[] = json.validators ?? [];
  const identities = new Set(
    validators
      .filter((v) => v.running_jito && v.identity_account)
      .map((v) => v.identity_account as string)
  );

  if (!identities.size) throw new Error("[leader] Jito validators API returned no identities");

  cachedJitoIdentities = identities;
  cacheFetchedAt = Date.now();
  logger.info(`[leader] Loaded ${identities.size} Jito-enabled validator identities`);
  return identities;
}

async function fetchLeaderSchedule(
  connection: Connection,
  currentSlot: number
): Promise<Map<number, string>> {
  if (cachedSchedule && Date.now() - cachedSchedule.fetchedAt < SCHEDULE_TTL_MS) {
    return cachedSchedule.map;
  }

  logger.info("[leader] Fetching leader schedule...");

  const schedule = await connection.getLeaderSchedule();
  if (!schedule) throw new Error("[leader] Could not fetch leader schedule");

  const epochInfo = await connection.getEpochInfo();
  const epochStartSlot = currentSlot - epochInfo.slotIndex;

  const slotToLeader = new Map<number, string>();
  for (const [validator, offsets] of Object.entries(schedule)) {
    for (const offset of offsets) {
      slotToLeader.set(epochStartSlot + offset, validator);
    }
  }

  cachedSchedule = { map: slotToLeader, fetchedAt: Date.now(), epochStart: epochStartSlot };
  logger.info(`[leader] Schedule loaded — ${slotToLeader.size} entries`);
  return slotToLeader;
}

export interface LeaderWindow {
  slot: number;
  validatorIdentity: string;
  isJitoEnabled: boolean;
}

export interface LeaderWindowOptions {
  /**
   * Ignore Jito leaders that are too close to the current slot. This avoids
   * selecting a leader that is gone by the time RPC blockhash fetch/retry and
   * bundle submission complete.
   */
  minLeadSlots?: number;
  /** Do not target leaders so far ahead that a fresh blockhash may expire first. */
  maxLeadSlots?: number;
}

function findJitoWindow(
  slot: number,
  slotToLeader: Map<number, string>,
  jitoIdentities: Set<string>,
  opts: LeaderWindowOptions = {}
): LeaderWindow | null {
  const minLeadSlots = opts.minLeadSlots ?? 0;
  const maxLeadSlots = Math.min(opts.maxLeadSlots ?? LOOKAHEAD_SLOTS, LOOKAHEAD_SLOTS);

  for (let i = minLeadSlots; i <= maxLeadSlots; i++) {
    const leader = slotToLeader.get(slot + i);
    if (leader && jitoIdentities.has(leader)) {
      return { slot: slot + i, validatorIdentity: leader, isJitoEnabled: true };
    }
  }
  return null;
}

export async function awaitJitoLeaderWindow(
  connection: Connection,
  yellowstone: YellowstoneClient,
  timeoutMs = 120_000,
  opts: LeaderWindowOptions = {}
): Promise<LeaderWindow> {
  logger.info(
    "[leader] Waiting for Jito-enabled leader window" +
    `${opts.minLeadSlots ? ` (${opts.minLeadSlots}+ slots lead)` : ""}...`
  );

  const jitoIdentities = await getJitoValidatorIdentities();
  const currentSlot = Math.max(
    yellowstone.getCurrentSlot(),
    await connection.getSlot("processed").catch(() => 0)
  );
  const slotToLeader = await fetchLeaderSchedule(connection, currentSlot);

  const immediate = findJitoWindow(currentSlot, slotToLeader, jitoIdentities, opts);
  if (immediate) {
    logger.info(
      `[leader] Jito leader at slot ${immediate.slot} — ${immediate.validatorIdentity.slice(0, 16)}... ` +
      `(${immediate.slot - currentSlot} slots ahead)`
    );
    return immediate;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      yellowstone.removeListener("slot", onSlot);
      reject(new Error(`[leader] Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSlot = (update: SlotUpdate) => {
      if (update.status !== "processed") return;
      const window = findJitoWindow(update.slot, slotToLeader, jitoIdentities, opts);
      if (!window) return;

      clearTimeout(timer);
      yellowstone.removeListener("slot", onSlot);
      logger.info(
        `[leader] Jito leader at slot ${window.slot} — ${window.validatorIdentity.slice(0, 16)}... ` +
        `(${window.slot - update.slot} slots ahead)`
      );
      resolve(window);
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
