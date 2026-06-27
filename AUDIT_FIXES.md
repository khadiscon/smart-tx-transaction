# Audit fixes applied

This revision addresses defects found in a deep audit of the original submission, and
then re-architects the stack so it reads as intentional infrastructure rather than a
rubric-gaming demo. Nothing here fabricates results - the verifiable lifecycle logs
still require a real mainnet run against your own RPC / Yellowstone endpoints and a
funded wallet.

## Re-architecture (intentional design, not a one-shot demo)
- Split the stack into a **reusable core** (`client.ts` / `SmartTxClient`) and a thin
  **benchmark harness** (`runner.ts` + CLI). The core takes any instruction list and
  submit options; it has no fixed run length and never calls `process.exit`.
- Removed the hardcoded "10 bundles then exit" flow. Submission count is now
  `--count=N` (default 5); the old behaviour was a script, not a service.
- Removed the baked-in self-sabotage. The original `buildBundleDescriptors` rigged
  bundles 6-10 to fail (`computeUnitPrice: 0`, `computeUnitLimit: 1`, stale blockhash,
  forced skip window). Fault injection now lives in an **opt-in** `--adverse` mode
  (`bundles.ts` / `ADVERSE_PROFILES`), is clearly labeled in the logs, and marks each
  profile `reliable` or not (the unreliable ones require `--include-unreliable`).
- Stopped feeding the agent fabricated signals (the old runner passed
  `isJitoEnabled: true` and a skip flag derived from the descriptor). The agent now
  receives only real slot context.
- Replaced the "low-budget" tip cap (fixed 50,000-200,000 lamports, plus discarding
  samples below the minimum) with a configurable percentile estimate (`TIP_PERCENTILE`,
  default p75) over every positive on-chain sample, clamped to a floor (protocol
  minimum 1,000) and an optional, configurable wallet-safety ceiling (default
  10,000,000; 0 disables).
- Removed dead/decorative code: `getBundleStatus` is now wired in as a real post-submit
  status check, and the cosmetic `describeAction` helper was deleted.
- `classifyFailure` now classifies purely from the real raw error, instead of being
  forced by the injected fault intent.

## Documentation (truthfulness)
- `NOTION_ARCHITECTURE.md` and `README.md` rewritten to match the new architecture
  (reusable core + harness, configurable count, opt-in adverse mode, percentile tipping
  with floor/ceiling). Earlier corrections are retained: the AI model is the real
  `llama-3.3-70b-versatile` via Groq (not the fictional "Hunter Alpha / OpenRouter /
  1T param / 1M context"); the bundle is a single v0 transaction with the tip as the
  last instruction; the endpoint is the Frankfurt regional block engine; and no
  fabricated latency figures are cited.
- Both docs now state honestly that deliberately-broken bundles are usually dropped at
  the block engine before landing, so the explorer-verifiable evidence is the
  successful landings, not the adverse cases.

## Code (correctness / honesty of logs)
- `agent.ts`: `callAgent` returns `{ action, reasoning, isSystemFailure }`; an agent-API
  failure (`failClosed`) is flagged so it is never reported as a genuine decision.
- `client.ts`: the lifecycle entry records the agent's real reasoning (or the real
  system-failure reason, prefixed `[agent unavailable]`).
- `client.ts`: `increase_tip` retries are clamped to the configured ceiling via
  `applyTipCeiling`.
- `client.ts`: `classifyFailure` distinguishes `tip_account_not_write_locked` from a
  generic `bundle_dropped`.
- `bundles.ts`: `fetchStaleBlockhash` throws instead of returning a degenerate
  all-zero blockhash.

## Still required before this can win (needs a live run)
1. Diagnose and fix the recurring `Bundles must write lock at least one tip account`
   rejection observed in the original logs - it cannot be confirmed fixed statically and
   needs a live run against real infrastructure to verify.
2. Run `npm install` and a typecheck (`npx tsc -p tsconfig.cli.json --noEmit`) in an
   environment with network access, then run the benchmark against real RPC / Yellowstone
   / Jito endpoints with a funded throwaway wallet.
3. Ship reconciled logs: at least one successful landing reaching `confirmed`/`finalized`
   with explorer-verifiable slots, plus the labeled adverse cases, with every lifecycle
   entry having a matching agent record.
4. Publish the architecture document to a public Notion page and fill in the README link.


---

## Post-run fix: Jito tip-account resolution (found via a real mainnet run)

**Symptom (from a real run's lifecycle-log.json):** intermittent bundle rejections with
`"Bundles must write lock at least one tip account to be eligible for the auction."`
Some submissions were accepted (returned a signature) while others were rejected in the
same run.

**Root cause:** `jito.ts` hardcoded the 8 Jito tip accounts, and 4 of the 8 base58
addresses were corrupted/typo'd. `submitJitoBundle` selects a tip account at random per
submission, so a run would intermittently tip a non-tip account and get rejected, while
runs that happened to pick a valid account passed the write-lock check.

**Fix:** Removed the hardcoded list entirely. Tip accounts are now fetched at runtime from
the block engine via the `getTipAccounts` JSON-RPC method (`getJitoTipAccounts()`), cached
for the process, and used for both tip sampling and the tip transfer. This guarantees we
only ever write-lock an account the auction recognizes, and it is resilient to Jito
rotating the set. If the endpoint cannot return the list, submission fails loudly instead
of silently tipping a bad account.

**Still environment-dependent (not code bugs):** the same run also showed `HTTP 429 -
Network congested. Endpoint is globally rate limited.` and 90s confirmation timeouts on
accepted bundles. These are symptoms of using the public Jito/RPC endpoints with very low
tips (1000-2250 lamports). A dedicated endpoint (e.g. the SolInfra ACE plan) plus tips
large enough to win the auction during a real Jito leader window are required for bundles
to actually land and produce explorer-verifiable confirmation slots.


---

## Post-run fix #2: Yellowstone disconnect crashed the process (found via a real run)

**Symptom:** mid-run, the gRPC stream dropped with `14 UNAVAILABLE: Connection dropped`
and the whole process threw an unhandled error and exited — so a run could never
complete a long sequence of submissions.

**Root cause (two bugs in `yellowstone.ts`):**
1. The stream's `error` handler called `this.emit("error", err)`. `YellowstoneClient`
   extends `EventEmitter`, and Node throws if an `"error"` event is emitted with no
   listener attached. Nothing listened for it, so any stream error crashed the process.
2. Reconnection was wired only to the stream's `"end"` event, but a dropped gRPC
   connection surfaces as `"error"`, not `"end"`. So even without the crash, it would
   never have reconnected.

**Fix:**
- The `error` handler no longer re-emits `"error"`. During initial connect it rejects the
  `connect()` promise (so startup failures still surface); once the stream is live it
  triggers a reconnect instead of crashing.
- Reconnection now fires on both `"error"` and `"end"`, via a single `scheduleReconnect()`
  guarded by a `reconnecting` flag so overlapping events can't spawn duplicate streams.
- On reconnect, old stream listeners are torn down and all in-flight transaction
  subscriptions are re-armed on the fresh stream in one combined Subscribe write
  (`writeAllTransactionSubscriptions`), which also fixes a latent bug where each
  per-signature subscribe replaced the previous one.
- Pending subscriptions are cleared when a wait resolves or times out.

Net effect: a dropped Yellowstone connection is now survivable — the client backs off,
reconnects (1s -> 30s exponential), and resumes streaming/confirmation instead of killing
the run.
