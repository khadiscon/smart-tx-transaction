/**
 * src/config.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === "") {
    throw new Error(
      `[config] Missing required environment variable: ${key}\n` +
      `  Copy .env.example to .env and fill in all values.`
    );
  }
  return val.trim();
}

export interface Config {
  rpcUrl: string;
  yellowstoneEndpoint: string;
  yellowstoneToken: string;
  walletPrivateKey: string;
  openrouterApiKey: string;
  logsDir: string;
  lifecycleLogPath: string;
  agentDecisionsPath: string;
}

function buildConfig(): Config {
  const logsDir = path.resolve(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  return {
    rpcUrl: require_env("RPC_URL"),
    yellowstoneEndpoint: require_env("YELLOWSTONE_ENDPOINT"),
    yellowstoneToken: require_env("YELLOWSTONE_TOKEN"),
    walletPrivateKey: require_env("WALLET_PRIVATE_KEY"),
    openrouterApiKey: require_env("OPENROUTER_API_KEY"),
    logsDir,
    lifecycleLogPath: path.join(logsDir, "lifecycle-log.json"),
    agentDecisionsPath: path.join(logsDir, "agent-decisions.json"),
  };
}

export const config = buildConfig();
