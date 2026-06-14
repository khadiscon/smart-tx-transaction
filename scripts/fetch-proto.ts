/**
 * scripts/fetch-proto.ts
 * Downloads geyser.proto from rpcpool/yellowstone-grpc
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";

const PROTO_URL = "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto";
const PROTO_PATH = path.resolve(__dirname, "../src/proto/geyser.proto");

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = (u: string) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); req(res.headers.location); return;
        }
        if (res.statusCode !== 200) {
          file.close(); fs.unlinkSync(dest);
          reject(new Error(`HTTP ${res.statusCode}`)); return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", (err) => { fs.unlinkSync(dest); reject(err); });
      });
    };
    req(url);
  });
}

async function main() {
  if (fs.existsSync(PROTO_PATH)) {
    const age = (Date.now() - fs.statSync(PROTO_PATH).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 7) { console.log(`[fetch-proto] Already exists (${age.toFixed(1)}d old) — skipping`); return; }
  }
  console.log("[fetch-proto] Downloading geyser.proto...");
  await download(PROTO_URL, PROTO_PATH);
  console.log(`[fetch-proto] Saved to ${PROTO_PATH} (${fs.statSync(PROTO_PATH).size} bytes)`);
}

main().catch((err) => { console.error("[fetch-proto]", err.message); process.exit(1); });
