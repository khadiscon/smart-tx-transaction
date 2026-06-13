/**
 * src/index.ts
 * Entry point — run with: npx ts-node --project tsconfig.cli.json src/index.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { logger } from "./logger";
import { YellowstoneClient } from "./yellowstone";
import { awaitJitoLeaderWindow } from "./leader";
import { runAllBundles, RunSummary } from "./runner";

const PROTO_URL = "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto";
const PROTO_PATH = path.resolve(process.cwd(), "src/proto/geyser.proto");

async function ensureProto(): Promise<void> {
  if (fs.existsSync(PROTO_PATH)) return;

  logger.info("[startup] Downloading geyser.proto...");
  fs.mkdirSync(path.dirname(PROTO_PATH), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(PROTO_PATH);
    const req = (url: string) => {
      https.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); req(res.headers.location); return;
        }
        if (res.statusCode !== 200) {
          file.close(); fs.unlinkSync(PROTO_PATH);
          reject(new Error(`HTTP ${res.statusCode}`)); return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
      }).on("error", reject);
    };
    req(PROTO_URL);
  });

  logger.info(`[startup] Proto saved to ${PROTO_PATH}`);
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║     smart-tx-stack  |  Jito Bundle CLI   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  await ensureProto();

  let payer: Keypair;
  try {
    payer = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
    logger.info(`[startup] Wallet: ${payer.publicKey.toBase58()}`);
  } catch (err: any) {
    logger.error(`[startup] Invalid WALLET_PRIVATE_KEY: ${err.message}`);
    process.exit(1);
  }

  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  const version = await connection.getVersion().catch(() => null);
  logger.info(`[startup] RPC: ${config.rpcUrl} (${version?.["solana-core"] ?? "?"})`);

  const balance = await connection.getBalance(payer.publicKey).catch(() => 0);
  logger.info(`[startup] Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.05 * 1e9) {
    logger.warn("[startup] Balance low (< 0.05 SOL) — tips may fail");
  }

  const yellowstone = new YellowstoneClient();

  try {
    await yellowstone.connect();
    logger.info("[startup] Yellowstone stream active.");
  } catch (err: any) {
    logger.error(`[startup] Yellowstone failed: ${err.message}`);
    process.exit(1);
  }

  await sleep(1_000);
  logger.info(`[startup] Current slot: ${yellowstone.getCurrentSlot()}`);

  logger.info("[startup] Waiting for Jito leader window...");
  const leaderWindow = await awaitJitoLeaderWindow(connection, yellowstone, 120_000).catch((err: Error) => {
    logger.warn(`[startup] ${err.message} — proceeding anyway`);
    return null;
  });

  if (leaderWindow) {
    logger.info(`[startup] Leader at slot ${leaderWindow.slot} — ${leaderWindow.validatorIdentity.slice(0, 20)}...`);
  }

  logger.info("\n[runner] Starting 10-bundle execution...\n");
  const summary = await runAllBundles(connection, payer, yellowstone);

  yellowstone.close();
  printSummary(summary);

  logger.info(`\n[done] Lifecycle log: ${config.lifecycleLogPath}`);
  logger.info(`[done] Agent decisions: ${config.agentDecisionsPath}`);

  process.exit(0);
}

function printSummary(summary: RunSummary): void {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log("  SMART-TX-STACK  |  EXECUTION SUMMARY");
  console.log(line);
  console.log(`  Total:                 ${summary.total}`);
  console.log(`  ✓ Succeeded:           ${summary.succeeded}`);
  console.log(`  ↺ Retried (landed):    ${summary.retried}`);
  console.log(`  ✗ Failed:              ${summary.failed}`);
  console.log(`  ⊘ Aborted by agent:    ${summary.aborted}`);
  console.log(`\n  Avg tip:               ${summary.avgTipLamports.toLocaleString()} lamports`);
  console.log(`  Avg submit→confirmed:  ${summary.avgSubmitToConfirmedMs > 0 ? summary.avgSubmitToConfirmedMs + "ms" : "N/A"}`);

  if (Object.keys(summary.failureBreakdown).length > 0) {
    console.log("\n  Failure breakdown:");
    for (const [type, count] of Object.entries(summary.failureBreakdown)) {
      console.log(`    ${type.padEnd(32)} ${count}`);
    }
  }

  console.log(`\n${line}`);
  console.log("  Per-bundle results:");
  console.log(line);

  const icon: Record<string, string> = { success: "✓", retried: "↺", failed: "✗", aborted: "⊘" };
  for (const r of summary.results) {
    const fault = r.faultType ? `[${r.faultType}]` : "[normal]";
    const agent = r.agentDecision ? `  agent=${r.agentDecision}` : "";
    const latency = r.submitToConfirmedMs ? `  ${r.submitToConfirmedMs}ms` : "";
    console.log(
      `  ${icon[r.status] ?? "?"} Bundle ${String(r.bundleNumber).padStart(2, "0")}  ${fault.padEnd(28)} tip=${r.tipLamports.toLocaleString().padEnd(12)} retries=${r.retryCount}${latency}${agent}`
    );
  }
  console.log(line + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.error(`[fatal] ${err.message}`);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
