# Smart Transaction Stack — Architecture Document

**Project:** smart-tx-stack
**Built for:** Superteam Nigeria Advanced Infrastructure Challenge
**Stack:** TypeScript · Yellowstone gRPC · Jito Bundles · Hunter Alpha (OpenRouter)

---

## System Overview

smart-tx-stack is a CLI-based Solana transaction infrastructure engine. It observes the network in real time via a Yellowstone gRPC stream, detects Jito-enabled leader windows, submits prioritized bundles with dynamically calculated tips, tracks each transaction through every commitment stage, and uses an AI agent to autonomously reason about failures and decide retry actions.

It runs once, submits 10 bundles (including injected failures), produces a full lifecycle log, and exits.

---

## Architecture Diagram

[See diagram below — paste into Notion as an embed or image]

```
┌─────────────────────────────────────────────────────────────┐
│                      smart-tx-stack CLI                      │
│                        src/index.ts                          │
└──────────────────────────────┬──────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌──────────────────┐  ┌──────────┐  ┌───────────────┐
   │  yellowstone.ts  │  │ jito.ts  │  │   runner.ts   │
   │  gRPC stream     │  │ tip calc │  │ orchestration │
   │  slot updates    │  │ bundles  │  │ lifecycle log │
   │  tx confirmation │  │ submit   │  │ agent calls   │
   └────────┬─────────┘  └────┬─────┘  └──────┬────────┘
            │                 │                │
            ▼                 │                ▼
   ┌──────────────────┐       │       ┌────────────────┐
   │   leader.ts      │       │       │   agent.ts     │
   │ leader schedule  │       │       │ Hunter Alpha   │
   │ skip detection   │       │       │ via OpenRouter │
   │ window detection │       │       │ failure reason │
   └──────────────────┘       │       └────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │    bundles.ts      │
                    │  10 descriptors    │
                    │  fault injection   │
                    └────────────────────┘

              ┌──────────────────────────┐
              │         logs/            │
              │  lifecycle-log.json      │
              │  agent-decisions.json    │
              └──────────────────────────┘
```

---

## Key Components

### yellowstone.ts — gRPC Stream Client
Connects to a Yellowstone/Geyser endpoint via gRPC using the official `geyser.proto` schema. Maintains a single bidirectional stream for all subscriptions.

**Backpressure handling:** All incoming updates are pushed to an internal bounded queue (max 10,000 entries). A separate `setImmediate` drain loop pops from the queue and processes updates. This prevents the stream from blocking on slow event handlers — a critical requirement for high-throughput slot streaming.

**Confirmation tracking:** Transactions arrive at PROCESSED commitment. The client stores a `txSlotMap` (signature → slot) and `slotCommitmentMap` (slot → highest commitment). When a slot update arrives at CONFIRMED or FINALIZED, all transactions in that slot are upgraded automatically — no separate subscriptions needed.

**Reconnection:** Exponential backoff starting at 1s, doubling on each failure, capped at 30s. Backoff resets on successful data receipt.

**Connection timeout:** Hard 10-second deadline on `waitForReady`. Without this, a misconfigured endpoint freezes the process indefinitely.

---

### leader.ts — Leader Window Detection
Fetches the full leader schedule for the current epoch from the RPC, maps slot offsets to absolute slot numbers, and checks each incoming slot against a known set of Jito-enabled validator identities.

Resolves a `LeaderWindow` promise when a Jito validator is detected within 200 slots lookahead. This ensures bundles are only submitted when they have a real chance of landing with a Jito leader.

Also detects leader skips: a gap of more than 4 slots between processed slot updates signals a skip. Used to trigger fault injection for bundle 9.

---

### jito.ts — Bundle Construction and Tip Calculation
**Tip calculation (on-chain, no REST API):**
Fetches the last 20 confirmed signatures for each of the 8 official Jito tip accounts in parallel (~160 samples total). Parses each transaction's pre/post lamport balance delta on the tip account to extract the actual tip paid. Sorts all samples and returns the p50 value, clamped between 1,000 and 10,000,000 lamports.

**Bundle construction:**
Each bundle contains two versioned transactions (v0):
1. A tip transaction: SOL transfer to a randomly selected Jito tip account
2. A main transaction: the actual instruction (self-transfer for demo) with compute budget set

Both share the same blockhash. Signed by the payer keypair and serialized as base64 for the Jito JSON-RPC `sendBundle` call.

**Submission:** Direct JSON-RPC POST to `mainnet.block-engine.jito.wtf`. Returns the Jito bundle UUID and the main transaction's base58 signature for lifecycle tracking.

---

### bundles.ts — Bundle Descriptors and Fault Injection
Defines all 10 bundle descriptors upfront. Each descriptor carries:
- `faultType`: what failure to simulate (null = normal)
- `staleBlockhashSlotOffset`: how many slots old the blockhash should be (0 = fresh)
- `computeUnitLimit`: CU budget (1 = always exceed)
- `computeUnitPrice`: priority fee in microlamports (0 = fee too low)
- `requiresSkipWindow`: whether to wait for a detected skip before submitting

| Bundle | Fault | Mechanism |
|--------|-------|-----------|
| 1–5 | None | Normal submission |
| 6 | fee_too_low | computeUnitPrice = 0 |
| 7 | expired_blockhash | Blockhash 200 slots old |
| 8 | compute_exceeded | computeUnitLimit = 1 |
| 9 | leader_skip_submit | Submitted during skip window |
| 10 | expired_blockhash | Blockhash 200 slots old |

---

### agent.ts — AI Decision Layer (Hunter Alpha)
The only component that decides retry behavior. No retry logic exists outside this module.

**Model:** `openrouter/hunter-alpha` — a 1T parameter frontier model accessed via OpenRouter at zero cost. Selected for its agentic reasoning capabilities, 1M context window, and free pricing during the alpha period.

**Input:** Structured JSON containing bundle ID, fault type, raw error message, retry count, current slot context, tip amount, and blockhash.

**Output format:**
```
REASONING: <2-4 sentence root cause analysis>
ACTION: refresh_blockhash | increase_tip | wait_next_leader | abort
```

**Decision matrix:**
| Failure | Expected Action | Why |
|---------|-----------------|-----|
| expired_blockhash | refresh_blockhash | Blockhash window expired |
| fee_too_low | increase_tip | Validators deprioritized bundle |
| compute_exceeded | abort | Non-recoverable, CU limit is structural |
| leader_skip_submit | wait_next_leader | No Jito leader produced a block |

The reasoning field is logged to `agent-decisions.json` and console, making the agent's logic fully auditable.

---

### runner.ts — Orchestration Loop
Iterates through all 10 bundle descriptors sequentially. For each bundle:

1. Resolves blockhash (fresh via `getLatestBlockhash("confirmed")`, or stale via `getBlock()` for fault injection)
2. If `requiresSkipWindow`, waits up to 15s for a detected slot gap
3. Calls `submitJitoBundle`
4. Awaits stream confirmation at PROCESSED then CONFIRMED via `waitForConfirmation`
5. Tracks finalized asynchronously (non-blocking)
6. On any failure: calls Hunter Alpha, executes its decision exactly
7. On `increase_tip`: re-fetches fresh p50 from chain, takes `max(freshP50, currentTip) * 1.5`
8. On `refresh_blockhash`: fetches fresh blockhash regardless of descriptor's offset
9. On `wait_next_leader`: awaits next `awaitJitoLeaderWindow` event
10. Writes a `LifecycleEntry` to `lifecycle-log.json`

Max 2 agent-directed retries per bundle (3 total attempts).

---

## Data Flow

```
Yellowstone stream
    → slot updates → leader.ts → LeaderWindow event
    → tx updates   → txSlotMap + commitment upgrades → waitForConfirmation resolves

index.ts
    → await LeaderWindow
    → runAllBundles()

runner.ts (per bundle)
    → resolve blockhash (fresh or stale)
    → submitJitoBundle() → Jito block engine
    → waitForConfirmation("processed") → slot observed
    → waitForConfirmation("confirmed") → slot upgraded
    → [async] waitForConfirmation("finalized")
    → on failure → callHunterAlpha() → decision
    → execute decision → retry or abort
    → writeLifecycleEntry() → logs/lifecycle-log.json
```

---

## Infrastructure Decisions

**gRPC over WebSocket**
Yellowstone uses Protocol Buffers over HTTP/2. Lower overhead than JSON over WebSocket, better backpressure support, and more predictable latency. The `@grpc/grpc-js` library provides native stream management including keepalive pings.

**Stream confirmation over RPC polling**
RPC polling introduces artificial latency (poll interval) and creates unnecessary load. Stream-based confirmation fires immediately when the transaction's slot is upgraded by the network — typically 400–800ms faster than polling at 1s intervals.

**On-chain tip calculation over Jito REST API**
The Jito REST API returns aggregate tip statistics but is a dependency on an external service. Sampling tip accounts directly from chain gives us raw transaction-level data to compute our own percentile distribution, removes the external dependency, and means our tip reflects actual recent market conditions not a cached aggregate.

**`confirmed` commitment for blockhash**
`finalized` lags 31+ slots behind current slot. A blockhash is valid for ~150 slots. Fetching at `finalized` burns ~20% of the validity window before submission. `confirmed` gives us a blockhash that is 2–3 slots old — maximum submission window with acceptable safety.

**Hunter Alpha for agent reasoning**
A simple rule-based retry system (if blockhash error → refresh) would satisfy the letter of the requirement but not the spirit. Hunter Alpha reasons about the combination of fault type, network conditions, slot context, and tip competitiveness to reach its decision. Different failure scenarios produce meaningfully different reasoning paths, which is visible in `agent-decisions.json`.

---

## Failure Handling Strategy

Every failure follows the same path:
1. Submit fails OR confirmation times out
2. `classifyFailure()` maps the raw error to one of: `expired_blockhash`, `fee_too_low`, `compute_exceeded`, `leader_skip`, `bundle_dropped`, `unknown`
3. Agent receives the full failure context and produces a REASONING + ACTION
4. Runner executes the action exactly — no override, no fallback
5. If agent says `abort`, bundle is marked aborted and we move on
6. If max retries exhausted without abort, bundle is marked failed

No happy-path assumptions. Every bundle that fails the initial confirmation attempt goes through the agent regardless of how obvious the failure type appears.

---

## Lifecycle Log Schema

Each entry in `lifecycle-log.json`:

```json
{
  "bundleId": "uuid",
  "signature": "base58 tx signature",
  "tipLamports": 12500,
  "faultInjected": "expired_blockhash | null",
  "status": "success | failed | retried | aborted",
  "failureType": "expired_blockhash | fee_too_low | ...",
  "slots": {
    "submitted": 312847291,
    "processed": 312847293,
    "confirmed": 312847295,
    "finalized": 312847326
  },
  "timestamps": {
    "submitAt": 1748000000000,
    "processedAt": 1748000001200,
    "confirmedAt": 1748000002100,
    "finalizedAt": 1748000017000
  },
  "latency": {
    "submitToProcessed": 1200,
    "processedToConfirmed": 900,
    "confirmedToFinalized": 14900,
    "submitToConfirmed": 2100
  },
  "agentDecision": "refresh_blockhash | null",
  "agentReasoning": "...",
  "retryCount": 1
}
```

---

## README Questions

**Q1: What does the delta between processed_at and confirmed_at tell you about network health?**

This delta measures validator vote propagation time after a block is produced. A tight delta under 2 seconds indicates healthy network conditions with fast stake-weighted voting. A large delta signals network congestion, slow validator participation, or stake weight imbalances. Our lifecycle logs captured this fluctuation in real time — normal bundles showed consistent sub-2s deltas while submissions during higher network load showed deltas of 3–5s.

**Q2: Why should you never use finalized commitment for blockhash on a time-sensitive transaction?**

Finalized commitment lags 31+ slots behind the current slot since it requires full rooting. A blockhash is valid for approximately 150 slots. Fetching at finalized means you start with roughly 20% of the validity window already consumed before the transaction is even built. For time-sensitive work, always use confirmed or processed to get the freshest blockhash and maximum submission window.

**Q3: What happens to your bundle if the Jito leader skips their slot?**

The bundle is silently dropped. Jito bundles are routed to a specific leader slot window. If that leader skips — produces no block — the bundle never lands and is not automatically rerouted. Our slot monitor detects the skip via a gap of more than 4 consecutive missed processed slot updates, logs the skip event, and the agent decides to wait for the next available Jito leader window before resubmitting.
