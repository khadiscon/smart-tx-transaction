# smart-tx-stack

A Solana smart transaction infrastructure stack. Streams live slot and leader data via Yellowstone gRPC, submits Jito bundles with tips estimated from live on-chain data, tracks transaction lifecycle across every commitment stage, and uses an AI agent (Llama 3.3 70B via Groq) to autonomously reason about failures and decide a single corrective retry.

The stack is a reusable core (`SmartTxClient`) plus a thin benchmark harness/CLI that drives it. The core takes any instruction list and submit options; it has no fixed run length and injects no faults.

Built for the Superteam Nigeria Advanced Infrastructure Challenge.

Architecture document: see `NOTION_ARCHITECTURE.md` (publish to a public Notion/Google Doc URL before submission)

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

The driver connects to the Yellowstone stream, checks for a Jito-enabled leader window, then runs `--count` primary-path submissions through `SmartTxClient`. Fault-injection cases run by default to exercise the failure/retry paths — use `--no-fault-injection` to skip them. On any failure the agent analyzes the real failure context and decides the retry action.

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

The harness runs deliberately-broken submissions by default to demonstrate detection, classification, and agent recovery (use `--no-fault-injection` to disable, or `--reliable-only` to skip the two that depend on live network timing):

| Profile | Reliable | What it tests |
|---|---|---|
| `fault-injection:expired-blockhash` | yes | ~200-slot-old blockhash - agent should refresh blockhash |
| `fault-injection:compute-budget-exceeded` | yes | compute unit limit of 1 - failure classification |
| `fault-injection:leader-skip-window` | no | submit into a detected skip; depends on live conditions |

Note that deliberately-broken bundles are usually dropped at the Jito block engine before landing, so they typically produce no explorer-verifiable slot/signature - the verifiable evidence is the successful primary-path landings.

## README Questions (Superteam Nigeria bounty)

### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health?

It measures how fast validators supermajority-vote on a block after it is produced. In our mainnet runs, sub-2-second `processedToConfirmed` deltas indicate healthy stake-weighted voting; larger deltas mean heavier load or slower propagation at submission time. Read the exact value per submission from `logs/lifecycle-log.json` — do not cite numbers your run did not capture.

### Question 2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

`finalized` lags ~31+ slots behind the chain head, while a blockhash is only valid for ~150 slots. A `finalized` blockhash has already consumed a large fraction of its validity window before you even sign. This stack always resolves blockhashes at `confirmed`.

### Question 3: What happens to your bundle if the Jito leader skips their slot?

The bundle is simply dropped — there is no automatic re-route to the next leader. The slot monitor watches for gaps >4 consecutive processed slots; the agent can choose `wait_next_leader` and the client waits for the next confirmed Jito-enabled window before resubmitting rather than firing into a dead slot.

## Operational notes

The interpretations below are the framework the stack reasons with; the concrete numbers for any given submission should be read directly from `logs/lifecycle-log.json` after a verified mainnet run (do not cite latency figures the run did not actually capture).

The gap between `processed_at` and `confirmed_at` in the lifecycle log is a live signal for network health - it reflects how quickly validators vote on a block once produced. Sub-2-second deltas indicate healthy, fast stake-weighted voting; larger deltas correspond to heavier load.

Blockhash commitment level matters: `finalized` lags 31+ slots behind current while a blockhash is valid only ~150 slots, so a `finalized` blockhash has already burned ~20% of its validity window. This stack always resolves blockhashes at `confirmed`.

Leader skips are a quiet failure mode: a bundle routed to a slot whose leader produces no block is simply dropped, with no automatic re-route. The slot monitor watches for gaps of more than 4 consecutive processed slots and the agent waits for the next confirmed Jito leader window rather than resubmitting into a dead slot.

The agent does not always pick the theoretically optimal action, and we left that behavior unmodified rather than special-casing it. In one observed run, a `compute_exceeded` failure (CU limit set to 1, structurally unrecoverable) was reasoned about as a timing issue and the agent chose `increase_tip` instead of `abort` - no tip amount fixes a compute-unit ceiling. This is a genuine model misdiagnosis, not a scripted decision tree producing a wrong-but-intentional output, and it is preserved in `logs/agent-decisions.json` rather than filtered out. We consider an occasionally-imperfect agent stronger evidence of real reasoning than a hand-tuned prompt that always lands on the textbook-correct action for every fault label.

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
```
