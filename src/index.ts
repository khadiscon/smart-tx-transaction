/**
 * src/index.ts
 * CLI entry point.
 *   npx ts-node --project tsconfig.cli.json src/index.ts [--count=N] [--no-adverse] [--reliable-only]
 *
 * Defaults satisfy the bounty's lifecycle-log requirement out of the box:
 * 8 primary-path submissions + all 3 fault-injection profiles = 11 total.
 *
 *   --count=N         number of primary-path submissions (default 8)
 *   --no-fault-injection
 *   --no-adverse      skip the labeled fault-injection cases
 *   --reliable-only   only run fault-injection profiles marked reliable (skips the 2 that
 *                      depend on live network timing rather than guaranteed failure)
 *   --startup-only    verify startup dependencies without submitting transactions
 *   --append-log      append to existing lifecycle/agent logs instead of clearing them
 *   --start-index=N   label primary-path submissions starting at N (default 1)
 *   --only-fault=LABEL
 *   --skip-fault=LABEL
 */

import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { logger } from "./logger";
import { YellowstoneClient } from "./yellowstone";
import { awaitJitoLeaderWindow } from "./leader";
import { runBenchmark, RunSummary } from "./runner";

// All three are required for the Yellowstone proto to load correctly.
// google/protobuf/timestamp.proto is a well-known type that geyser.proto
// imports; if it's missing, @grpc/proto-loader silently resolves an empty
// package definition instead of throwing, so we verify upfront with a
// clear error rather than letting that surface as a confusing runtime bug.
const REQUIRED_PROTO_FILES = [
  {
    file: "geyser.proto",
    requiredText: ["package geyser", "service Geyser", "rpc Subscribe"],
  },
  {
    file: "solana-storage.proto",
    requiredText: ["package solana.storage.ConfirmedBlock"],
  },
  {
    file: path.join("google", "protobuf", "timestamp.proto"),
    requiredText: ["package google.protobuf", "message Timestamp"],
  },
];

function ensureProto(): void {
  const protoDir = path.resolve(process.cwd(), "src/proto");
  const invalid = REQUIRED_PROTO_FILES.filter(({ file, requiredText }) => {
    const fullPath = path.join(protoDir, file);
    if (!fs.existsSync(fullPath)) return true;
    const stat = fs.statSync(fullPath);
    if (stat.size <= 0) return true;
    const body = fs.readFileSync(fullPath, "utf8");
    return !requiredText.every((needle) => body.includes(needle));
  });

  if (invalid.length > 0) {
    throw new Error(
      `[startup] Missing or invalid proto file(s): ${invalid.map((p) => p.file).join(", ")}\n` +
      `  Run: npm run proto:fetch`
    );
  }
}

interface CliArgs {
  count: number;
  faultInjection: boolean;
  includeUnreliable: boolean;
  startupOnly: boolean;
  appendLog: boolean;
  startIndex: number;
  onlyFaultLabels: string[];
  skipFaultLabels: string[];
}

function parseArgs(): CliArgs {
  let count = 8;
  let faultInjection = true;
  let includeUnreliable = true;
  let startupOnly = false;
  let appendLog = false;
  let startIndex = 1;
  const onlyFaultLabels: string[] = [];
  const skipFaultLabels: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--count=")) {
      const n = parseInt(arg.split("=")[1], 10);
      count = Number.isFinite(n) && n >= 0 ? n : 8;
    } else if (arg === "--no-adverse" || arg === "--no-fault-injection") {
      faultInjection = false;
    } else if (arg === "--reliable-only") {
      includeUnreliable = false;
    } else if (arg === "--startup-only") {
      startupOnly = true;
    } else if (arg === "--append-log") {
      appendLog = true;
    } else if (arg.startsWith("--start-index=")) {
      const n = parseInt(arg.split("=")[1], 10);
      startIndex = Number.isFinite(n) && n > 0 ? n : 1;
    } else if (arg.startsWith("--only-fault=")) {
      onlyFaultLabels.push(normalizeFaultLabel(arg.split("=")[1]));
    } else if (arg.startsWith("--skip-fault=")) {
      skipFaultLabels.push(normalizeFaultLabel(arg.split("=")[1]));
    }
  }
  return {
    count,
    faultInjection,
    includeUnreliable,
    startupOnly,
    appendLog,
    startIndex,
    onlyFaultLabels,
    skipFaultLabels,
  };
}

function normalizeFaultLabel(label: string): string {
  return label.startsWith("fault-injection:") ? label : `fault-injection:${label}`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("\nsmart-tx-stack  |  Jito smart transaction stack\n");

  ensureProto();

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

  try {
    const version = await connection.getVersion();
    logger.info(`[startup] RPC: ${config.rpcUrl} (${version["solana-core"]})`);
  } catch (err: any) {
    logger.warn(`[startup] RPC version check failed: ${err.message}`);
  }

  try {
    const balance = await connection.getBalance(payer.publicKey);
    logger.info(`[startup] Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  } catch (err: any) {
    logger.warn(`[startup] Balance check failed: ${err.message}`);
  }

  const yellowstone = new YellowstoneClient();
  try {
    await yellowstone.connect();
    await yellowstone.waitForHealthyStream(15_000);
    logger.info("[startup] Yellowstone stream active.");
  } catch (err: any) {
    logger.error(`[startup] Yellowstone unavailable (${err.message})`);
    logger.error("[startup] Refusing to run bounty benchmark without a live Yellowstone stream.");
    process.exit(1);
  }

  await sleep(1_000);
  logger.info(`[startup] Current slot: ${yellowstone.getCurrentSlot()}`);

  logger.info("[startup] Checking for an upcoming Jito leader window...");
  const leaderWindow = await awaitJitoLeaderWindow(connection, yellowstone, 30_000).catch((err: Error) => {
    logger.warn(`[startup] ${err.message} - proceeding anyway`);
    return null;
  });
  if (leaderWindow) {
    logger.info(`[startup] Leader at slot ${leaderWindow.slot} - ${leaderWindow.validatorIdentity.slice(0, 20)}...`);
  }

  if (args.startupOnly) {
    await yellowstone.waitForHealthyStream(20_000);
    yellowstone.close();
    logger.info("[startup] Startup-only check complete.");
    process.exit(0);
  }

  logger.info(
    `\n[benchmark] Plan: ${args.count} primary-path submission(s)` +
    `${args.faultInjection ? " + fault-injection case(s)" : ""}\n`
  );

  if (!args.appendLog) {
    fs.writeFileSync(config.lifecycleLogPath, "");
    fs.writeFileSync(config.agentDecisionsPath, "");
  } else {
    logger.info("[benchmark] Append-log mode: preserving existing lifecycle and agent logs");
  }

  const summary = await runBenchmark(connection, payer, yellowstone, {
    primarySubmissionCount: args.count,
    primaryStartIndex: args.startIndex,
    faultInjection: args.faultInjection,
    includeUnreliableFaults: args.includeUnreliable,
    onlyFaultLabels: args.onlyFaultLabels,
    skipFaultLabels: args.skipFaultLabels,
  });

  yellowstone.close();
  printSummary(summary);

  logger.info(`\n[done] Lifecycle log: ${config.lifecycleLogPath}`);
  logger.info(`[done] Agent decisions: ${config.agentDecisionsPath}`);

  process.exit(0);
}

function printSummary(summary: RunSummary): void {
  const line = "-".repeat(64);
  console.log(`\n${line}`);
  console.log("  SMART-TX-STACK  |  EXECUTION SUMMARY");
  console.log(line);
  console.log(`  Total:                 ${summary.total}`);
  console.log(`  Succeeded:             ${summary.succeeded}`);
  console.log(`  Retried (landed):      ${summary.retried}`);
  console.log(`  Failed:                ${summary.failed}`);
  console.log(`  Aborted by agent:      ${summary.aborted}`);
  console.log(`\n  Avg tip:               ${summary.avgTipLamports.toLocaleString()} lamports`);
  console.log(`  Avg submit->confirmed: ${summary.avgSubmitToConfirmedMs > 0 ? summary.avgSubmitToConfirmedMs + "ms" : "N/A"}`);

  if (Object.keys(summary.failureBreakdown).length > 0) {
    console.log("\n  Failure breakdown:");
    for (const [type, count] of Object.entries(summary.failureBreakdown)) {
      console.log(`    ${type.padEnd(32)} ${count}`);
    }
  }

  console.log(`\n${line}`);
  console.log("  Per-submission results:");
  console.log(line);
  summary.results.forEach((r, i) => {
    const fault = r.faultInjected ? `[${r.faultInjected}]` : "[primary-path]";
    const agent = r.agentDecision ? `  agent=${r.agentDecision}` : "";
    const latency = r.submitToConfirmedMs ? `  ${r.submitToConfirmedMs}ms` : "";
    console.log(
      `  ${String(i + 1).padStart(2, "0")} ${r.status.padEnd(8)} ${fault.padEnd(28)} ` +
      `tip=${r.tipLamports.toLocaleString().padEnd(12)} retries=${r.retryCount}${latency}${agent}`
    );
  });
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
