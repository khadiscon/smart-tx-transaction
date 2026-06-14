# smart-tx-stack

A Solana smart transaction infrastructure stack. Streams live slot and leader data via Yellowstone gRPC, submits Jito bundles with on-chain dynamic tips, tracks transaction lifecycle across every commitment stage, and uses an AI agent (Hunter Alpha via OpenRouter) to autonomously reason about failures and decide retries.

Built for the Superteam Nigeria Advanced Infrastructure Challenge.

Architecture document: [link to public Notion page]

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
OPENROUTER_API_KEY=your_openrouter_api_key
```

## Run

```bash
npm start
```

This connects to the Yellowstone stream, waits for a Jito-enabled leader window, then submits 10 bundles sequentially. Bundles 6–10 each carry an injected fault. On any failure, Hunter Alpha analyzes the failure context and decides the retry action.

Output:
- `logs/lifecycle-log.json` — one entry per bundle: signature, tip, slots at each commitment stage, timestamps, latency deltas, agent decision
- `logs/agent-decisions.json` — one entry per agent call: failure context, reasoning, action taken

## Bundle plan

| Bundle | Fault | What it tests |
|---|---|---|
| 1–5 | None | Normal submission path |
| 6 | fee_too_low | Zero compute unit price — agent should increase tip |
| 7 | expired_blockhash | Blockhash 200 slots old — agent should refresh blockhash |
| 8 | compute_exceeded | Compute unit limit of 1 — agent should abort |
| 9 | leader_skip_submit | Submitted during a detected leader skip — agent should wait for next leader |
| 10 | expired_blockhash | Second expired blockhash case |

## Operational notes

A few things worth knowing about how this stack behaves under real network conditions, based on running it against mainnet.

The gap between `processed_at` and `confirmed_at` in the lifecycle log is a live signal for network health. It reflects how quickly validators vote on a block once produced — sub-2-second deltas indicate healthy, fast stake-weighted voting, while deltas of 3-5 seconds correspond to periods of heavier load. Each bundle's latency numbers effectively act as a small probe of network conditions at that moment.

Blockhash commitment level matters more than it first appears. `finalized` lags 31+ slots behind the current slot because it requires full rooting, while a blockhash is only valid for roughly 150 slots — so a blockhash fetched at `finalized` has already burned about 20% of its validity window before the transaction is even built. This stack always resolves blockhashes at `confirmed` (typically 2-3 slots behind current) to preserve the maximum submission window.

Leader skips are a quiet failure mode. If the Jito leader assigned to a slot doesn't produce a block, any bundle routed to that slot is simply dropped — there's no automatic re-route. The slot monitor watches for gaps of more than 4 consecutive processed slots and treats that as a skip signal. The agent's response in that case is to wait for the next confirmed Jito leader window rather than resubmitting into a dead slot.

## Project structure

```
src/
  config.ts        env loading and validation
  logger.ts        winston logger + JSON log writers
  yellowstone.ts   gRPC stream client, backpressure queue, confirmation tracking
  leader.ts        leader schedule, Jito window detection, skip detection
  jito.ts          on-chain p50 tip calculation, bundle construction and submission
  bundles.ts       10 bundle descriptors with fault injection
  agent.ts         Hunter Alpha via OpenRouter
  runner.ts        orchestration loop
  index.ts         entry point
scripts/
  fetch-proto.ts   downloads geyser.proto from rpcpool/yellowstone-grpc
```
