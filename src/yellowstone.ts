/**
 * src/yellowstone.ts
 * Yellowstone gRPC client — slot streaming, tx confirmation, backpressure queue.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import bs58 from "bs58";
import { logger } from "./logger";
import { config } from "./config";

const PROTO_PATH = path.resolve(process.cwd(), "src/proto/geyser.proto");

function loadProto(): any {
  if (!fs.existsSync(PROTO_PATH)) {
    throw new Error(
      `[yellowstone] geyser.proto not found at ${PROTO_PATH}\n` +
      `  Run: npx ts-node --project tsconfig.cli.json scripts/fetch-proto.ts`
    );
  }
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  return grpc.loadPackageDefinition(def);
}

export interface SlotUpdate {
  slot: number;
  parent: number | undefined;
  status: "processed" | "confirmed" | "finalized";
}

export interface TxConfirmation {
  signature: string;
  slot: number;
  status: "processed" | "confirmed" | "finalized";
  err: string | null;
}

export class YellowstoneClient extends EventEmitter {
  private client: any = null;
  private stream: any = null;
  private meta: grpc.Metadata | null = null;
  private latestSlot = 0;
  private updateQueue: any[] = [];
  private readonly QUEUE_LIMIT = 10_000;
  private txSlotMap = new Map<string, number>();
  private slotCommitmentMap = new Map<number, "processed" | "confirmed" | "finalized">();
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private closed = false;

  constructor() {
    super();
    this.setMaxListeners(200);
  }

  async connect(): Promise<void> {
    const proto = loadProto();
    const endpoint = config.yellowstoneEndpoint;
    const url = new URL(endpoint.startsWith("http") ? endpoint : `https://${endpoint}`);
    const address = `${url.hostname}:${url.port || "443"}`;

    this.meta = new grpc.Metadata();
    this.meta.add("x-token", config.yellowstoneToken);

    const GeyserService = proto?.geyser?.Geyser ?? proto?.yellowstone?.geyser?.Geyser;
    if (!GeyserService) {
      throw new Error("[yellowstone] Geyser service not found in proto");
    }

    this.client = new GeyserService(address, grpc.credentials.createSsl(), {
      "grpc.max_receive_message_length": 128 * 1024 * 1024,
      "grpc.keepalive_time_ms": 10_000,
      "grpc.keepalive_timeout_ms": 5_000,
      "grpc.keepalive_permit_without_calls": 1,
    });

    logger.info(`[yellowstone] Connecting to ${address}...`);

    await new Promise<void>((resolve, reject) => {
      this.client.waitForReady(new Date(Date.now() + 10_000), (err: Error | null) => {
        if (err) reject(new Error(`[yellowstone] Connection failed: ${err.message}`));
        else resolve();
      });
    });

    logger.info("[yellowstone] Connected.");
    await this.startStream();
    this.startQueueDrain();
  }

  private async startStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream = this.client.Subscribe(this.meta);
      let resolved = false;
      const settle = (fn: () => void) => { if (!resolved) { resolved = true; fn(); } };

      this.stream.on("data", (update: any) => {
        settle(resolve);
        this.reconnectDelay = 1_000; // reset backoff on successful data
        if (this.updateQueue.length >= this.QUEUE_LIMIT) this.updateQueue.shift();
        this.updateQueue.push(update);
      });

      this.stream.on("error", (err: Error) => {
        logger.error(`[yellowstone] Stream error: ${err.message}`);
        settle(() => reject(err));
        this.emit("error", err);
      });

      this.stream.on("end", () => {
        if (this.closed) return;
        logger.warn(`[yellowstone] Stream ended — reconnecting in ${this.reconnectDelay}ms...`);
        setTimeout(() => this.reconnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
      });

      this.writeSubscription({
        slots: { client: { filter_by_commitment: false } },
        accounts: {},
        transactions: {},
        blocks: {},
        blocks_meta: {},
        entry: {},
        commitment: 0,
        accounts_data_slice: [],
        ping: null,
      });

      setTimeout(() => settle(resolve), 3_000);
    });
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    logger.info("[yellowstone] Reconnecting...");
    try {
      await this.startStream();
      logger.info("[yellowstone] Reconnected successfully.");
    } catch (err: any) {
      logger.error(`[yellowstone] Reconnect failed: ${err.message} — retrying in ${this.reconnectDelay}ms`);
      setTimeout(() => this.reconnect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
    }
  }

  private startQueueDrain(): void {
    const drain = () => {
      while (this.updateQueue.length > 0) {
        this.handleUpdate(this.updateQueue.shift()!);
      }
      setImmediate(drain);
    };
    setImmediate(drain);
  }

  private handleUpdate(update: any): void {
    if (update?.slot) {
      const slot = parseInt(update.slot.slot, 10);
      const raw = (update.slot.status ?? "PROCESSED").toUpperCase();
      const status: "processed" | "confirmed" | "finalized" =
        raw.includes("FINAL") ? "finalized" :
        raw.includes("CONFIRM") ? "confirmed" : "processed";

      if (status === "processed" && slot > this.latestSlot) this.latestSlot = slot;

      this.emit("slot", {
        slot,
        parent: update.slot.parent ? parseInt(update.slot.parent, 10) : undefined,
        status,
      });

      if (status === "confirmed" || status === "finalized") {
        this.slotCommitmentMap.set(slot, status);
        this.upgradePendingTx(slot, status);
      }
    }

    if (update?.transaction) {
      const txData = update.transaction;
      const rawSig = txData.transaction?.transaction?.signatures?.[0];
      if (!rawSig) return;

      const signature = Buffer.isBuffer(rawSig)
        ? bs58.encode(Uint8Array.from(rawSig))
        : rawSig;

      const slot = parseInt(txData.slot, 10);
      const err = txData.transaction?.meta?.err ?? null;

      this.txSlotMap.set(signature, slot);

      const conf: TxConfirmation = {
        signature,
        slot,
        status: "processed",
        err: err ? JSON.stringify(err) : null,
      };

      this.emit("txUpdate", conf);
      this.emit(`tx:${signature}`, conf);

      const known = this.slotCommitmentMap.get(slot);
      if (known === "confirmed" || known === "finalized") {
        this.upgradePendingTx(slot, known);
      }
    }
  }

  private upgradePendingTx(slot: number, status: "confirmed" | "finalized"): void {
    for (const [sig, txSlot] of this.txSlotMap.entries()) {
      if (txSlot === slot) {
        this.emit(`tx:${sig}`, { signature: sig, slot, status, err: null });
        if (status === "finalized") this.txSlotMap.delete(sig);
      }
    }
  }

  subscribeToTransaction(signature: string): void {
    if (!this.stream) return;
    this.writeSubscription({
      slots: { client: { filter_by_commitment: false } },
      accounts: {},
      transactions: {
        [signature]: {
          vote: false,
          failed: true,
          signature,
          account_include: [],
          account_exclude: [],
          account_required: [],
        },
      },
      blocks: {},
      blocks_meta: {},
      entry: {},
      commitment: 0,
      accounts_data_slice: [],
      ping: null,
    });
  }

  private writeSubscription(req: any): void {
    if (!this.stream) return;
    this.stream.write(req, (err: Error | null) => {
      if (err) logger.warn(`[yellowstone] Subscription write failed: ${err.message}`);
    });
  }

  waitForConfirmation(
    signature: string,
    targetCommitment: "processed" | "confirmed" | "finalized" = "confirmed",
    timeoutMs = 60_000
  ): Promise<TxConfirmation> {
    return new Promise((resolve, reject) => {
      const rank = { processed: 0, confirmed: 1, finalized: 2 };
      const timer = setTimeout(() => {
        this.removeAllListeners(`tx:${signature}`);
        reject(new Error(`[yellowstone] Timeout (${timeoutMs}ms) for ${signature.slice(0, 16)}...`));
      }, timeoutMs);

      this.subscribeToTransaction(signature);

      const onUpdate = (conf: TxConfirmation) => {
        if (rank[conf.status] >= rank[targetCommitment]) {
          clearTimeout(timer);
          this.removeListener(`tx:${signature}`, onUpdate);
          resolve(conf);
        }
      };

      this.on(`tx:${signature}`, onUpdate);
    });
  }

  getCurrentSlot(): number { return this.latestSlot; }

  close(): void {
    this.closed = true;
    try { this.stream?.end(); } catch {}
    try { this.client?.close(); } catch {}
    logger.info("[yellowstone] Closed.");
  }
}
