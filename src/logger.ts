/**
 * src/logger.ts
 */

import * as winston from "winston";
import * as fs from "fs";
import { config } from "./config";

const { combine, timestamp, colorize, printf } = winston.format;

export const logger = winston.createLogger({
  level: "info",
  format: combine(
    timestamp({ format: "HH:mm:ss.SSS" }),
    colorize(),
    printf(({ level, message, timestamp: ts }) => `[${ts}] ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

export interface SlotCommitmentStages {
  submitted?: number;
  processed?: number;
  confirmed?: number;
  finalized?: number;
}

export interface TimestampStages {
  submitAt?: number;
  processedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
}

export interface LatencyDeltas {
  submitToProcessed?: number;
  processedToConfirmed?: number;
  confirmedToFinalized?: number;
  submitToConfirmed?: number;
}

export type AgentAction =
  | "refresh_blockhash"
  | "increase_tip"
  | "wait_next_leader"
  | "abort";

export type BundleStatus = "success" | "failed" | "retried" | "aborted";

export interface LifecycleEntry {
  bundleId: string;
  signature: string | null;
  tipLamports: number;
  faultInjected: string | null;
  status: BundleStatus;
  failureType: string | null;
  slots: SlotCommitmentStages;
  timestamps: TimestampStages;
  latency: LatencyDeltas;
  agentDecision?: AgentAction;
  agentReasoning?: string;
  retryCount: number;
}

export interface AgentDecisionEntry {
  bundleId: string;
  timestamp: number;
  isoTime: string;
  faultType: string | null;
  rawError: string;
  slotContext: Record<string, unknown>;
  action: AgentAction;
  reasoning: string;
  model: string;
}

function appendJsonLine(filePath: string, entry: unknown): void {
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function writeLifecycleEntry(entry: LifecycleEntry): void {
  appendJsonLine(config.lifecycleLogPath, entry);
  logger.info(
    `[lifecycle] bundle=${entry.bundleId.slice(0, 8)} status=${entry.status} tip=${entry.tipLamports} latency=${entry.latency.submitToConfirmed ?? "?"}ms`
  );
}

export function writeAgentDecision(entry: AgentDecisionEntry): void {
  appendJsonLine(config.agentDecisionsPath, entry);
  logger.info(`[agent] bundle=${entry.bundleId.slice(0, 8)} action=${entry.action} model=${entry.model}`);
}
