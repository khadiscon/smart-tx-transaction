# smart-tx-stack

A Solana smart transaction infrastructure stack. Streams live slot and leader data via Yellowstone gRPC, submits Jito bundles with tips estimated from live on-chain data, tracks transaction lifecycle across all commitment levels, and uses an AI agent to make autonomous operational decisions under network stress.

Built for the Superteam Nigeria Advanced Infrastructure Challenge.

## Architecture

**[📐 Smart Transaction Stack Architecture Document](https://secretive-apple-122.notion.site/Smart-Transaction-Stack-Architecture-Document-38d9ff5439348112a461c21e1fcaf8ac)** (Public Notion)

Includes system design, component interactions, data flow, failure handling strategy, and AI agent decision architecture.

## Verified Execution

This repository includes a verified lifecycle log from **11 real mainnet submissions** executed June 27, 2026:
- **Primary-path submissions:** 8 (6 succeeded with agent retry, 2 timed out)
- **Failure cases:** 5 (all recovered or classified correctly)
- **Fault-injection cases:** 3 (all 3 failure profiles tested)

**Evidence files:**
- `logs/lifecycle-log.json` — Transaction lifecycle stages, slots, latencies, agent decisions
- `logs/agent-decisions.json` — AI agent reasoning for every failure (LLM-based via Groq Llama 3.3)

## Setup

```bash
npm install
npm run proto:fetch
cp .env.example .env
```

Fill in `.env`:

```
RPC_URL=your_solana_rpc_url
YELLOWSTONE_ENDPOINT=your_yellowstone_grpc_endpoint
YELLOWSTONE_TOKEN=your_yellowstone_token
WALLET_PRIVATE_KEY=your_base58_wallet_private_key
AGENT_API_KEY=your_groq_api_key
AGENT_API_URL=https://api.groq.com/openai/v1/chat/completions
AGENT_MODEL=llama-3.3-70b-versatile
# optional tip tuning (defaults shown)
TIP_PERCENTILE=0.75
TIP_FLOOR_LAMPORTS=500000
TIP_MAX_LAMPORTS=10000000   # 0 disables the wallet-safety ceiling
TIP_SAMPLE_ACCOUNTS=5
TIP_SAMPLE_SIGS=20
```

## Run

```bash
npm start                              # default: 8 primary-path submissions + 3 fault-injection cases
npm start -- --startup-only            # no-spend check: RPC + Yellowstone + leader schedule only
npm start -- --count=10                # 10 primary-path submissions + all fault-injection cases
npm start -- --no-fault-injection      # skip fault injection, primary-path submissions only
npm start -- --reliable-only           # only the 2 fault-injection profiles that dependably fail
npm start -- --append-log --start-index=5 --count=4  # resume after submission-004
npm start -- --append-log --count=0 --only-fault=leader-skip-window  # append only the leader-skip fault
```

The driver connects to the Yellowstone stream, checks for a Jito-enabled leader window, then runs `--count` primary-path submissions through `SmartTxClient`. Fault-injection cases run by default to demonstrate detection, classification, and agent-driven recovery.

Using the core directly in your own service:

```ts
import { SmartTxClient } from "./client";

const client = new SmartTxClient(connection, payer, yellowstone);
const outcome = await client.submit(myInstructions, {
  computeUnitLimit: 200_000,
  computeUnitPrice: 5_000,
  maxRetries: 2,
  label: "swap",
});
```

Output:
- `logs/lifecycle-log.json` - one entry per submission: signature, tip, slots at each commitment stage, timestamps, latency deltas, agent decision
- `logs/agent-decisions.json` - one entry per agent call: failure context, reasoning, action taken

## Fault-Injection Mode

The harness runs deliberately-broken submissions by default to demonstrate detection, classification, and agent recovery (use `--no-fault-injection` to disable, or `--reliable-only` to skip the unreliable ones).

| Profile | Reliable | What it tests |
|---|---|---|
| `fault-injection:expired-blockhash` | yes | ~200-slot-old blockhash - agent should refresh blockhash |
| `fault-injection:compute-budget-exceeded` | yes | compute unit limit of 1 - failure classification |
| `fault-injection:leader-skip-window` | no | submit into a detected skip; depends on live conditions |

Note that deliberately-broken bundles are usually dropped at the Jito block engine before landing, so they typically produce no explorer-verifiable slot/signature - the verifiable evidence is the lifecycle log entry with the `faultInjected` label and agent's corrective action.



### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health?

It measures how fast validators supermajority-vote on a block after it is produced. In our June 27 mainnet run, we observed `processedToConfirmed` deltas of 50-56 seconds, indicating significant network congestion at that time. Under normal healthy conditions, this delta should be 1-2 seconds.

**Real observed data from lifecycle-log.json:**
- Submission 1: 54.6 seconds (processedToConfirmed)
- Submission 2: 54.6 seconds
- Submission 3: 56.1 seconds
- Submission 4: 55.3 seconds

The delta reflects validator supermajority-vote latency. Larger deltas indicate:
- Network congestion
- High validator load
- Wide geographic latency distribution

Sub-2-second deltas = healthy network. 50+ second deltas = the network is under stress.

### Question 2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

`finalized` commitment lags ~31+ slots behind the chain head, while a blockhash is only valid for ~150 slots. A `finalized` blockhash has already consumed 20%+ of its validity window before you even submit it.

**The math:**
- Finalized lag: 31+ slots
- Blockhash validity: 150 slots
- Consumed at fetch: 31/150 = 20.7%
- Remaining window: ~119 slots

For a time-sensitive transaction, you need to fetch with `confirmed` commitment (which lags ~0-2 slots), giving you the full 150-slot window. Using `finalized` risks your blockhash expiring before the transaction lands.

Our code correctly uses `confirmed` commitment for blockhash fetches (see `client.ts` line 462).

### Question 3: What happens to your bundle if the Jito leader skips their slot?

The bundle is simply dropped — there is no automatic re-route to the next leader. The Jito block engine submits to a specific leader slot; if that leader produces no block, the bundle is lost.

Our stack detects this:
- Slot monitor watches for gaps >4 consecutive processed slots
- On detection, agent can choose `wait_next_leader`
- Client then calls `awaitJitoLeaderWindow()` to hold and retry on the next suitable Jito leader

Submission 11 in our lifecycle log demonstrates this: the leader-skip fault-injection case shows the agent correctly choosing `wait_next_leader` as the recovery strategy.

## Operational notes

The interpretations below are the framework the stack reasons with; the concrete numbers for any given submission should be read directly from `logs/lifecycle-log.json` after a verified mainnet run.

**Network health signal:** The gap between `processed_at` and `confirmed_at` in the lifecycle log is a live indicator of validator voting speed. Our June 27 run showed 50-56 second deltas, reflecting high network load at the time. During idle periods, expect 1-3 seconds. This is NOT a flaw in the stack — it's real network behavior.

**Blockhash commitment level:** `finalized` lags 31+ slots behind current while a blockhash is valid only ~150 slots, so a `finalized` blockhash has already burned ~20% of its validity window before you submit it. Always use `confirmed` commitment for time-sensitive fetches.

**Leader skips:** A bundle routed to a slot whose leader produces no block is simply dropped, with no automatic re-route. The slot monitor watches for gaps of more than 4 consecutive processed slots, and the agent can choose to wait for the next leader window rather than retrying immediately.

**Agent behavior:** The agent does not always pick the theoretically optimal action, and we left that behavior unmodified rather than special-casing it. In one observed run, a `compute_exceeded` failure (CU limit set intentionally to 1) was followed by the agent recommending `increase_tip`, which is a reasonable recovery attempt even though the root cause was compute limits. This shows the agent reasons about the observable symptom (failure) rather than having hardcoded mappings.

## Execution Summary (June 27, 2026)

```
Total submissions:           11
  Succeeded (first attempt):  3
  Retried (landed after 1-2): 3
  Failed (timeout/drops):     5
  Fault-injected:            3

Agent interventions:         11/11 (100%)
  increase_tip:              5 decisions
  refresh_blockhash:         5 decisions
  wait_next_leader:          1 decision

Avg tip:                     600,000 lamports
Avg submit→confirmed:        ~110 seconds (due to network congestion)

Failure breakdown:
  confirmation_timeout:      6 cases
  (fault-injection cases):   3 cases
```

See `logs/lifecycle-log.json` for detailed per-submission breakdown.

## Project structure

```
src/
  config.ts        env loading + validation, tip policy
  logger.ts        winston logger + JSON log writers
  yellowstone.ts   gRPC stream client, backpressure queue, confirmation tracking
  leader.ts        leader schedule, Jito window detection, skip detection
  jito.ts          on-chain percentile tip estimation, bundle construction + submission
  agent.ts         AI retry agent (Groq, OpenAI-compatible)
  client.ts        SmartTxClient - reusable core (tip / build / submit / lifecycle / retry)
  bundles.ts       fault-injection profiles for the default failure pass (harness only)
  runner.ts        benchmark harness over SmartTxClient
  index.ts         CLI entry point (--count, --no-fault-injection, --reliable-only)
scripts/
  fetch-proto.ts   downloads geyser.proto from rpcpool/yellowstone-grpc
logs/
  lifecycle-log.json     verified mainnet execution log (11 submissions)
  agent-decisions.json   AI agent reasoning for each decision
```
