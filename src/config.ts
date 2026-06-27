/**
 * src/config.ts
 * Loads and validates runtime configuration from the environment.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === "") {
    throw new Error(
      `[config] Missing required environment variable: ${key}\n` +
      `  Copy .env.example to .env and fill in all values.`
    );
  }
  return val.trim();
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`[config] ${key} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

/** Tipping policy. Tips are estimated from live on-chain data, not hardcoded. */
export interface TipPolicy {
  /** Percentile of observed on-chain tips to target (0..1). Higher = more competitive. */
  percentile: number;
  /** Hard floor in lamports. The protocol minimum Jito tip is 1000 lamports. */
  floorLamports: number;
  /** Wallet-safety ceiling in lamports. 0 disables the ceiling entirely. */
  maxLamports: number;
  /** How many of the official tip accounts to sample. */
  accountsToSample: number;
  /** How many recent signatures to inspect per sampled account. */
  sigsPerAccount: number;
}

export interface Config {
  rpcUrl: string;
  yellowstoneEndpoint: string;
  yellowstoneToken: string;
  walletPrivateKey: string;
  agentApiKey: string;
  agentApiUrl: string;
  agentModel: string;
  jitoBlockEngineUrl: string;
  logsDir: string;
  lifecycleLogPath: string;
  agentDecisionsPath: string;
  tip: TipPolicy;
}

function buildConfig(): Config {
  const logsDir = path.resolve(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  return {
    rpcUrl: requireEnv("RPC_URL"),
    yellowstoneEndpoint: requireEnv("YELLOWSTONE_ENDPOINT"),
    yellowstoneToken: requireEnv("YELLOWSTONE_TOKEN"),
    walletPrivateKey: requireEnv("WALLET_PRIVATE_KEY"),
    agentApiKey: requireEnv("AGENT_API_KEY"),
    agentApiUrl:
      process.env.AGENT_API_URL?.trim() ||
      "https://api.groq.com/openai/v1/chat/completions",
    agentModel: process.env.AGENT_MODEL?.trim() || "llama-3.3-70b-versatile",
    jitoBlockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL?.trim() ||
      "https://frankfurt.mainnet.block-engine.jito.wtf",
    logsDir,
    lifecycleLogPath: path.join(logsDir, "lifecycle-log.json"),
    agentDecisionsPath: path.join(logsDir, "agent-decisions.json"),
    tip: {
      percentile: numEnv("TIP_PERCENTILE", 0.75),
      floorLamports: numEnv("TIP_FLOOR_LAMPORTS", 500_000),
      maxLamports: numEnv("TIP_MAX_LAMPORTS", 10_000_000),
      accountsToSample: numEnv("TIP_SAMPLE_ACCOUNTS", 5),
      sigsPerAccount: numEnv("TIP_SAMPLE_SIGS", 20),
    },
  };
}

export const config = buildConfig();
