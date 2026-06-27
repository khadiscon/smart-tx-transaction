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
  const protoBody = fs.readFileSync(PROTO_PATH, "utf8");
  if (!protoBody.includes("service Geyser") || !protoBody.includes("rpc Subscribe")) {
    throw new Error(
      `[yellowstone] geyser.proto is incomplete or invalid at ${PROTO_PATH}\n` +
      `  Run: npm run proto:fetch`
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
  if (Object.keys(def).length === 0) {
    throw new Error(
      "[yellowstone] proto-loader returned an empty package definition. " +
      "Check that all imports exist under src/proto, then run npm run proto:fetch."
    );
  }
  return grpc.loadPackageDefinition(def);
}

function findGrpcService(root: any, serviceName: string): any {
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const [key, value] of Object.entries(node ?? {})) {
      if (key === serviceName && typeof value === "function" && (value as any).service) {
        return value;
      }
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return null;
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
  private GeyserService: any = null;
  private address = "";
  private latestSlot = 0;
  private latestSlotAt = 0;
  private updateQueue: any[] = [];
  private readonly QUEUE_LIMIT = 10_000;
  private txSlotMap = new Map<string, number>();
  private txConfirmationMap = new Map<string, TxConfirmation>();
  private slotCommitmentMap = new Map<number, "processed" | "confirmed" | "finalized">();
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private closed = false;
  private reconnecting = false;
  private drainStarted = false;
  private trackedSignatures = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(200);
  }

  async connect(): Promise<void> {
    const proto = loadProto();
    const endpoint = config.yellowstoneEndpoint;
    const url = new URL(endpoint.startsWith("http") ? endpoint : `https://${endpoint}`);
    this.address = `${url.hostname}:${url.port || "443"}`;

    this.meta = new grpc.Metadata();
    this.meta.add("x-token", config.yellowstoneToken);

    this.GeyserService = proto?.geyser?.Geyser ?? proto?.yellowstone?.geyser?.Geyser ?? findGrpcService(proto, "Geyser");
    if (!this.GeyserService) {
      throw new Error("[yellowstone] Geyser service not found in proto");
    }

    logger.info(`[yellowstone] Connecting to ${this.address}...`);

    let lastError = "connection failed";
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.createClient();
        await this.waitForClientReady();
        await this.startStream();
        if (!this.drainStarted) {
          this.drainStarted = true;
          this.startQueueDrain();
        }
        logger.info("[yellowstone] Connected.");
        return;
      } catch (err: any) {
        lastError = err.message ?? String(err);
        this.teardownClient();
        const exhausted = lastError.includes("RESOURCE_EXHAUSTED");
        if (attempt < 5) {
          const delay = exhausted ? 8_000 * (attempt + 1) : 2_000 * (attempt + 1);
          logger.warn(`[yellowstone] Connect attempt ${attempt + 1} failed — retrying in ${delay}ms`);
          await sleep(delay);
        }
      }
    }

    throw new Error(`[yellowstone] ${lastError}`);
  }

  private async createClient(): Promise<void> {
    this.teardownClient();
    this.client = new this.GeyserService(this.address, grpc.credentials.createSsl(), {
      "grpc.max_receive_message_length": 128 * 1024 * 1024,
      "grpc.keepalive_time_ms": 10_000,
      "grpc.keepalive_timeout_ms": 5_000,
      "grpc.keepalive_permit_without_calls": 1,
    });
  }

  private waitForClientReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.waitForReady(new Date(Date.now() + 10_000), (err: Error | null) => {
        if (err) reject(new Error(`[yellowstone] Connection failed: ${err.message}`));
        else resolve();
      });
    });
  }

  private async startStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream = this.client.Subscribe(this.meta);
      let resolved = false;
      const settle = (fn: () => void) => { if (!resolved) { resolved = true; fn(); } };

      this.stream.on("data", (update: any) => {
        settle(resolve);
        this.reconnectDelay = 1_000;
        if (this.updateQueue.length >= this.QUEUE_LIMIT) this.updateQueue.shift();
        this.updateQueue.push(update);
      });

      this.stream.on("error", (err: Error) => {
        logger.error(`[yellowstone] Stream error: ${err.message}`);
        if (!resolved) {
          settle(() => reject(err));
        } else {
          this.teardownStream();
          this.scheduleReconnect(err.message);
        }
      });

      this.stream.on("end", () => {
        if (this.closed) return;
        this.teardownStream();
        this.scheduleReconnect();
      });

      this.flushSubscription();

      setTimeout(() => settle(resolve), 3_000);
    });
  }

  private scheduleReconnect(reason = ""): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;

    const exhausted = reason.includes("RESOURCE_EXHAUSTED");
    if (exhausted) {
      this.reconnectDelay = Math.max(this.reconnectDelay, 30_000);
    }

    logger.warn(`[yellowstone] Stream lost — reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => this.reconnect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
  }

  private teardownStream(): void {
    if (!this.stream) return;
    try {
      this.stream.removeAllListeners();
      this.stream.cancel?.();
      this.stream.end?.();
    } catch {}
    this.stream = null;
  }

  private teardownClient(): void {
    this.teardownStream();
    if (!this.client) return;
    try { this.client.close(); } catch {}
    this.client = null;
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    logger.info("[yellowstone] Reconnecting...");
    this.teardownClient();

    try {
      await this.createClient();
      await this.waitForClientReady();
      await this.startStream();
      this.reconnecting = false;
      this.reconnectDelay = 1_000;
      logger.info("[yellowstone] Reconnected successfully.");
    } catch (err: any) {
      this.reconnecting = false;
      logger.error(`[yellowstone] Reconnect failed: ${err.message} — retrying in ${this.reconnectDelay}ms`);
      this.scheduleReconnect(err.message);
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
      if (status === "processed" && slot >= this.latestSlot) this.latestSlotAt = Date.now();

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
      this.handleTransactionUpdate(update.transaction, "processed");
    }

    if (update?.transaction_status) {
      this.handleTransactionStatusUpdate(update.transaction_status);
    }
  }

  private decodeSignature(rawSig: unknown): string | null {
    if (!rawSig) return null;
    if (Buffer.isBuffer(rawSig)) return bs58.encode(Uint8Array.from(rawSig));
    if (typeof rawSig === "string") return rawSig;
    return null;
  }

  private emitTxConfirmation(conf: TxConfirmation): void {
    this.txSlotMap.set(conf.signature, conf.slot);
    this.txConfirmationMap.set(conf.signature, conf);
    this.emit("txUpdate", conf);
    this.emit(`tx:${conf.signature}`, conf);
  }

  private handleTransactionUpdate(txData: any, status: TxConfirmation["status"]): void {
    const rawSig = txData.transaction?.transaction?.signatures?.[0] ?? txData.signature;
    const signature = this.decodeSignature(rawSig);
    if (!signature) return;

    const slot = parseInt(txData.slot, 10);
    const err = txData.transaction?.meta?.err ?? null;

    this.emitTxConfirmation({
      signature,
      slot,
      status,
      err: err ? JSON.stringify(err) : null,
    });

    const known = this.slotCommitmentMap.get(slot);
    if (known === "confirmed" || known === "finalized") {
      this.upgradePendingTx(slot, known);
    }
  }

  private handleTransactionStatusUpdate(txStatus: any): void {
    const signature = this.decodeSignature(txStatus.signature);
    if (!signature) return;

    const slot = parseInt(txStatus.slot, 10);
    const err = txStatus.err ?? null;
    const status: TxConfirmation["status"] =
      this.slotCommitmentMap.get(slot) === "finalized" ? "finalized" : "confirmed";

    this.emitTxConfirmation({
      signature,
      slot,
      status,
      err: err ? JSON.stringify(err) : null,
    });
  }

  private upgradePendingTx(slot: number, status: "confirmed" | "finalized"): void {
    for (const [sig, txSlot] of this.txSlotMap.entries()) {
      if (txSlot === slot) {
        this.emitTxConfirmation({ signature: sig, slot, status, err: null });
        if (status === "finalized") this.txSlotMap.delete(sig);
      }
    }
  }

  subscribeToTransaction(signature: string): void {
    if (this.trackedSignatures.has(signature)) return;
    this.trackedSignatures.add(signature);
    this.flushSubscription();
  }

  private buildTransactionFilter(signature: string) {
    return {
      vote: false,
      failed: true,
      signature,
      account_include: [],
      account_exclude: [],
      account_required: [],
    };
  }

  private flushSubscription(): void {
    const txFilters = Object.fromEntries(
      [...this.trackedSignatures].map((sig) => [sig, this.buildTransactionFilter(sig)])
    );

    this.writeSubscription({
      slots: { client: { filter_by_commitment: false } },
      accounts: {},
      transactions: txFilters,
      transactions_status: txFilters,
      blocks: {},
      blocks_meta: {},
      entry: {},
      commitment: 1,
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
      const cached = this.txConfirmationMap.get(signature);
      if (cached && rank[cached.status] >= rank[targetCommitment]) {
        resolve(cached);
        return;
      }

      const timer = setTimeout(() => {
        this.removeListener(`tx:${signature}`, onUpdate);
        this.trackedSignatures.delete(signature);
        reject(new Error(`[yellowstone] Timeout (${timeoutMs}ms) for ${signature.slice(0, 16)}...`));
      }, timeoutMs);

      const onUpdate = (conf: TxConfirmation) => {
        if (rank[conf.status] >= rank[targetCommitment]) {
          clearTimeout(timer);
          this.removeListener(`tx:${signature}`, onUpdate);
          if (targetCommitment === "finalized") this.trackedSignatures.delete(signature);
          resolve(conf);
        }
      };

      this.on(`tx:${signature}`, onUpdate);
      this.subscribeToTransaction(signature);
    });
  }

  getCurrentSlot(): number { return this.latestSlot; }

  isConnected(): boolean { return this.stream !== null && !this.closed; }

  hasFreshSlot(maxAgeMs = 10_000): boolean {
    return this.isConnected() && this.latestSlot > 0 && Date.now() - this.latestSlotAt <= maxAgeMs;
  }

  waitForHealthyStream(timeoutMs = 60_000): Promise<void> {
    if (this.hasFreshSlot()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("slot", onSlot);
        reject(new Error(`[yellowstone] No fresh slot update within ${timeoutMs}ms`));
      }, timeoutMs);

      const onSlot = (update: SlotUpdate) => {
        if (update.status !== "processed") return;
        clearTimeout(timer);
        this.removeListener("slot", onSlot);
        resolve();
      };

      this.on("slot", onSlot);
    });
  }

  close(): void {
    this.closed = true;
    this.teardownClient();
    logger.info("[yellowstone] Closed.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
