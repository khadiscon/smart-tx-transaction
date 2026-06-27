/**
 * scripts/fetch-proto.ts
 * Downloads geyser.proto, its solana-storage.proto dependency, and the
 * google/protobuf/timestamp.proto well-known type geyser.proto imports.
 * All three are required — without the well-known type, @grpc/proto-loader
 * silently resolves an empty package definition instead of erroring.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";

const PROTO_BASE = "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto";
const GOOGLE_PROTO_URL = "https://raw.githubusercontent.com/protocolbuffers/protobuf/main/src/google/protobuf/timestamp.proto";
const PROTO_FILES = [
  {
    file: "geyser.proto",
    requiredText: ["package geyser", "service Geyser", "rpc Subscribe"],
  },
  {
    file: "solana-storage.proto",
    requiredText: ["package solana.storage.ConfirmedBlock"],
  },
] as const;
const PROTO_DIR = path.resolve(__dirname, "../src/proto");
const GOOGLE_PROTO_DEST = path.join(PROTO_DIR, "google", "protobuf", "timestamp.proto");
const GOOGLE_REQUIRED_TEXT = ["package google.protobuf", "message Timestamp"];

function isValidProto(dest: string, requiredText: readonly string[]): boolean {
  if (!fs.existsSync(dest)) return false;
  const stat = fs.statSync(dest);
  if (stat.size <= 0) return false;
  const body = fs.readFileSync(dest, "utf8");
  return requiredText.every((needle) => body.includes(needle));
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}`;
    let file = fs.createWriteStream(tmpDest);
    let settled = false;

    const cleanup = () => {
      try { file.close(); } catch {}
      if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      fs.renameSync(tmpDest, dest);
      resolve();
    };

    const req = (u: string) => {
      const request = https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          file = fs.createWriteStream(tmpDest);
          req(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          fail(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); done(); });
      });
      request.on("error", fail);
    };
    file.on("error", fail);
    req(url);
  });
}

async function main() {
  for (const { file, requiredText } of PROTO_FILES) {
    const dest = path.join(PROTO_DIR, file);

    if (isValidProto(dest, requiredText)) {
      const age = (Date.now() - fs.statSync(dest).mtimeMs) / (1000 * 60 * 60 * 24);
      if (age < 7) {
        console.log(`[fetch-proto] ${file} already exists (${age.toFixed(1)}d old) — skipping`);
        continue;
      }
    } else if (fs.existsSync(dest)) {
      console.log(`[fetch-proto] ${file} exists but is incomplete/invalid — refetching`);
    }

    console.log(`[fetch-proto] Downloading ${file}...`);
    await download(`${PROTO_BASE}/${file}`, dest);
    if (!isValidProto(dest, requiredText)) {
      throw new Error(`${file} downloaded but did not contain the expected proto definitions`);
    }
    console.log(`[fetch-proto] Saved to ${dest} (${fs.statSync(dest).size} bytes)`);
  }

  // geyser.proto imports "google/protobuf/timestamp.proto" — a well-known
  // type not bundled with @grpc/proto-loader. Without this on disk at the
  // exact import path, protoLoader.loadSync silently resolves to an empty
  // package definition (no exception thrown), which is why the Geyser
  // service lookup fails with no obvious cause.
  if (isValidProto(GOOGLE_PROTO_DEST, GOOGLE_REQUIRED_TEXT)) {
    const age = (Date.now() - fs.statSync(GOOGLE_PROTO_DEST).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 30) {
      console.log(`[fetch-proto] google/protobuf/timestamp.proto already exists (${age.toFixed(1)}d old) — skipping`);
      return;
    }
  } else if (fs.existsSync(GOOGLE_PROTO_DEST)) {
    console.log("[fetch-proto] google/protobuf/timestamp.proto exists but is incomplete/invalid — refetching");
  }

  console.log("[fetch-proto] Downloading google/protobuf/timestamp.proto...");
  await download(GOOGLE_PROTO_URL, GOOGLE_PROTO_DEST);
  if (!isValidProto(GOOGLE_PROTO_DEST, GOOGLE_REQUIRED_TEXT)) {
    throw new Error("google/protobuf/timestamp.proto downloaded but did not contain the expected proto definitions");
  }
  console.log(`[fetch-proto] Saved to ${GOOGLE_PROTO_DEST} (${fs.statSync(GOOGLE_PROTO_DEST).size} bytes)`);
}

main().catch((err) => {
  console.error("[fetch-proto]", err?.message || String(err));
  process.exit(1);
});
