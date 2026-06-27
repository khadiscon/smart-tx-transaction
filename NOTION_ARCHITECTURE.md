# Smart Transaction Stack - Architecture Document

**Project:** smart-tx-stack
**Built for:** Superteam Nigeria Advanced Infrastructure Challenge
**Stack:** TypeScript - Yellowstone gRPC - Jito Bundles - Groq Llama 3.3 70B

---

## System Overview

smart-tx-stack is a Solana transaction infrastructure library with a CLI driver. It observes the network in real time via a Yellowstone gRPC stream, detects Jito-enabled leader windows, submits prioritized bundles with tips estimated from live on-chain data, tracks each transaction through every commitment stage, and uses an AI agent to autonomously reason about failures and decide a single corrective retry action.

The stack is split into two layers:

- **Reusable core (`SmartTxClient`)** - the product. You hand it a set of instructions and submit options; it estimates a tip, builds and signs a single-transaction Jito bundle, submits it, tracks the lifecycle, and retries under agent direction. It has no fixed run length, never injects faults, and never exits the process.
- **Benchmark harness (`runner.ts` + CLI)** - a thin driver that exercises the core a configurable number of times to produce lifecycle logs. Adverse mode runs by default to deliberately drive the failure paths under clearly-labeled conditions; `--no-adverse` disables it.

This separation is deliberate: the original version was a one-shot script that fired a hardcoded ten bundles (five of them rigged to fail) and then called `process.exit`. That is a demo, not infrastructure. The core is now a component you can import into a real service; the benchmark is just one consumer of it.

---

## Architecture Diagram

```
+-------------------------------------------------------------+
|                   CLI driver / harness                      |
|              src/index.ts  +  src/runner.ts                 |
|   --count=N   --no-adverse   --reliable-only                |
+------------------------------+------------------------------+
                               |
                               v
                    +---------------------+
                    |     client.ts       |
                    |   SmartTxClient     |   <-- reusable core
                    |  submit(ixs, opts)  |
                    |  tip / build / sign |
                    |  lifecycle + retry  |
                    +----+-----+-----+----+
                         |     |     |
          +--------------+     |     +--------------+
          v                    v                    v
  +----------------+   +----------------+   +----------------+
  | yellowstone.ts |   |    jito.ts     |   |    agent.ts    |
  | gRPC stream    |   | tip estimate   |   | Groq           |
  | slot updates   |   | build + submit |   | Llama 3.3 70B  |
  | tx confirmation|   | bundle status  |   | failure reason |
  +-------+--------+   +----------------+   +----------------+
          |
          v
  +----------------+                       +----------------+
  |   leader.ts    |                        |  bundles.ts    |
  | leader sched   |                        | ADVERSE_       |
  | window detect  |                        | PROFILES       |
  | skip detection |                        | (harness only) |
  +----------------+                        +----------------+

            +------------------------------+
            |            logs/             |
            |   lifecycle-log.json         |
            |   agent-decisions.json       |
            +------------------------------+
```

---

## Key Components

### client.ts - SmartTxClient (reusable core)
The heart of the stack. `new SmartTxClient(connection, payer, yellowstone)` exposes a single method:

```ts
submit(instructions: TransactionInstruction[], opts?: SubmitOptions): Promise<BundleOutcome>
```

`SubmitOptions` covers `computeUnitLimit` (default 200,000), `computeUnitPrice` (default 1,000 micro-lamports), `maxRetries` (default 2), a `label`, an honest `faultInjected` tag, and an optional `initialBlockhash` override used only for adverse stale-blockhash testing.

Per submission the client:
1. Estimates a competitive tip from live chain data (`getCompetitiveTip`).
2. Prepends compute-budget instructions to the caller's payload.
3. Builds, signs and submits a single v0-transaction bundle (`submitJitoBundle`), then logs the Jito bundle status.
4. Tracks `processed` then `confirmed` over the Yellowstone stream, with `finalized` tracked asynchronously.
5. On failure, calls the agent once and executes exactly one corrective action (`refresh_blockhash`, `increase_tip`, `wait_next_leader`, or `abort`), up to `maxRetries`.
6. Writes one `LifecycleEntry`.

The core has no concept of a bundle count and never injects a fault on its own.

### yellowstone.ts - gRPC Stream Client
Connects to a Yellowstone/Geyser endpoint via gRPC using the official `geyser.proto` schema, over a single bidirectional stream.

**Backpressure:** incoming updates are pushed to a bounded queue (max 10,000) and drained by a separate `setImmediate` loop so slow handlers never block the stream. **Confirmation tracking:** transactions arrive at PROCESSED; a `txSlotMap` and `slotCommitmentMap` upgrade them automatically as slot updates reach CONFIRMED/FINALIZED. **Reconnection:** exponential backoff from 1s to 30s, reset on data. **Connection timeout:** hard 10s deadline on `waitForReady`.

### leader.ts - Leader Window Detection
Fetches the epoch leader schedule, maps slot offsets to absolute slots, and resolves a `LeaderWindow` when a Jito-enabled validator is detected within the lookahead. Also exposes `awaitLeaderSkipWindow`, which reports a skip when a gap of more than 4 consecutive processed slots is observed. The core uses the leader window for `wait_next_leader`; the harness uses skip detection only for the opt-in `adverse:leader_skip` profile.

### jito.ts - Tip Estimation and Bundle Submission
**Tip estimation (on-chain, configurable, no hardcoded values):** samples the official Jito tip accounts (default 5, `TIP_SAMPLE_ACCOUNTS`) and inspects recent signatures per account (default 20, `TIP_SAMPLE_SIGS`), extracting the real tip paid from each transaction's pre/post lamport delta on the tip account. It keeps every positive sample (no minimum-tip filtering, which would bias the estimate upward), then returns a configurable percentile (`TIP_PERCENTILE`, default p75 - competitive without overpaying), clamped to a floor (`TIP_FLOOR_LAMPORTS`, default 1,000, the protocol minimum) and an optional wallet-safety ceiling (`TIP_MAX_LAMPORTS`, default 10,000,000; set 0 to disable). There is no fixed "low-budget" cap.

**Bundle construction:** each bundle is a single v0 transaction. The caller's compute-budget and payload instructions come first; a SOL transfer to a randomly chosen Jito tip account is appended as the **last** instruction, which write-locks the tip account in the same transaction (no separate tip transaction needed). **Submission:** JSON-RPC `sendBundle` POST to the Frankfurt regional block engine by default (`JITO_BLOCK_ENGINE_URL` to override). `getBundleStatus` polls `getBundleStatuses` for an honest post-submit status line.

### bundles.ts - Adverse Profiles (harness only)
Not used by the core. Defines `AdverseProfile` and `ADVERSE_PROFILES` for the harness's default failure-injection pass, plus `fetchStaleBlockhash`. Each profile is marked `reliable` or not:

| Profile | Reliable | Mechanism |
|---|---|---|
| `adverse:expired_blockhash` | yes | ~200-slot-old blockhash, exercises `refresh_blockhash` recovery |
| `adverse:compute_exceeded` | yes | compute-unit limit of 1, exercises failure classification |
| `adverse:fee_too_low` | no | zero priority fee; unreliable on Jito (landing is tip-driven) |
| `adverse:leader_skip` | no | submit into a detected skip gap; depends on live conditions |

All four profiles run by default; `--reliable-only` restricts to the two that dependably fail, since pretending an unreliable trigger always fails would be dishonest.

### agent.ts - AI Decision Layer (Groq Llama 3.3 70B)
The only component that decides retry behavior. Model `llama-3.3-70b-versatile` over Groq's OpenAI-compatible chat-completions API; provider/model/endpoint are env-configurable. Input is structured JSON: bundle id, fault tag, raw error, retry count, real slot context (current slot and observed submit slot - no fabricated signals), tip amount, blockhash. Output is parsed from a strict `REASONING:` / `ACTION:` format. The model's reasoning is logged to `agent-decisions.json`. If the API call or parse fails, `failClosed()` records the real system-failure reason and flags it (`isSystemFailure`), so an infrastructure outage is never presented as a reasoned decision.

### runner.ts - Benchmark Harness
`runBenchmark(connection, payer, yellowstone, { normalCount, adverse, includeUnreliableAdverse })` constructs one `SmartTxClient` and drives it: `normalCount` normal submissions (default 8), then, unless `--no-adverse` was passed, the labeled adverse profiles (all four by default, or just the reliable two with `--reliable-only`). A `demoPayload` (a zero-lamport self-transfer, clearly marked as a placeholder to replace with real instructions) is the sample payload. The harness builds `SubmitOptions` from each adverse profile - fetching a stale blockhash or awaiting a skip window where required - and aggregates a `RunSummary`.

---

## Infrastructure Decisions

**gRPC over WebSocket** - Yellowstone uses Protocol Buffers over HTTP/2: lower overhead, better backpressure, more predictable latency, native keepalive via `@grpc/grpc-js`.

**Stream confirmation over RPC polling** - stream-based confirmation fires the moment a transaction's slot is upgraded, removing poll-interval latency and unnecessary RPC load.

**On-chain tip estimation over the Jito REST API** - sampling tip accounts directly yields raw transaction-level data to compute our own percentile, removes an external dependency, and reflects actual recent market conditions rather than a cached aggregate.

**`confirmed` commitment for blockhash** - `finalized` lags 31+ slots; a blockhash is valid ~150 slots, so fetching at `finalized` burns ~20% of the window. `confirmed` keeps the blockhash 2-3 slots old for the maximum submission window.

**LLM agent for retry reasoning** - rather than a fixed rule table, the agent reasons over the combination of error, slot context, and tip competitiveness, and fails closed to `abort` (logged as such) when unreachable.

---

## Failure Handling Strategy

Every failed attempt follows the same path:
1. Submit fails OR confirmation times out.
2. `classifyFailure()` maps the **real** raw error - never a pre-labeled intent - to one of `expired_blockhash`, `compute_exceeded`, `tip_account_not_write_locked`, `fee_too_low`, `leader_skip`, `confirmation_timeout`, `bundle_dropped`, `unknown`.
3. The agent receives the full real context and returns REASONING + ACTION.
4. The client executes that action exactly - no override.
5. `abort` marks the submission aborted; exhausting `maxRetries` marks it failed.

**Honest note on adverse failures:** deliberately broken bundles (stale blockhash, 1-CU compute) are typically rejected/dropped at the Jito block engine *before* landing, so they usually produce no explorer-verifiable landed signature or slot. The explorer-verifiable evidence of this stack is the **successful** landings; the adverse cases demonstrate detection, classification, and agent-driven recovery, and are logged honestly as dropped/rejected.

---

## Lifecycle Log Schema

Each entry in `lifecycle-log.json`:

```json
{
  "bundleId": "uuid",
  "signature": "base58 tx signature | null",
  "tipLamports": 12500,
  "faultInjected": "adverse:expired_blockhash | null",
  "status": "success | failed | retried | aborted",
  "failureType": "expired_blockhash | compute_exceeded | ... | null",
  "slots": { "submitted": 0, "processed": 0, "confirmed": 0, "finalized": 0 },
  "timestamps": { "submitAt": 0, "processedAt": 0, "confirmedAt": 0, "finalizedAt": 0 },
  "latency": { "submitToProcessed": 0, "processedToConfirmed": 0, "confirmedToFinalized": 0, "submitToConfirmed": 0 },
  "agentDecision": "refresh_blockhash | null",
  "agentReasoning": "...",
  "retryCount": 1
}
```

Slot/timestamp/latency sub-fields are only populated for the stages a submission actually reached; do not cite figures a run did not capture.

---

## README Questions

**Q1: What does the delta between processed_at and confirmed_at tell you about network health?**

It measures validator vote propagation after a block is produced. A tight delta (under ~2s) indicates healthy, fast stake-weighted voting; a large delta signals congestion or slow participation. Read the actual per-submission `processedToConfirmed` values from `logs/lifecycle-log.json` for the run being submitted - do not cite deltas the run did not capture.

**Q2: Why should you never use finalized commitment for blockhash on a time-sensitive transaction?**

`finalized` lags 31+ slots because it requires full rooting, and a blockhash is valid only ~150 slots - so fetching at `finalized` consumes roughly 20% of the validity window before the transaction is even built. Use `confirmed` or `processed` for the freshest blockhash and maximum submission window.

**Q3: What happens to your bundle if the Jito leader skips their slot?**

It is silently dropped - bundles are routed to a specific leader slot window and are not automatically rerouted. The slot monitor detects the skip via a gap of more than 4 consecutive missed processed slots, logs it, and the agent chooses to wait for the next confirmed Jito leader window before resubmitting.
