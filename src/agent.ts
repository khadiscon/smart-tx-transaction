/**
 * src/agent.ts
 * AI retry agent - reasons about a failure and returns one corrective action.
 *
 * Provider-agnostic via env: AGENT_API_URL, AGENT_API_KEY, AGENT_MODEL.
 * Defaults to Groq's Llama 3.3 70B (OpenAI-compatible, fast, strong
 * instruction-following, which matters since we parse a strict
 * REASONING/ACTION format from the raw response).
 */

import { config } from "./config";
import { logger, writeAgentDecision, AgentAction } from "./logger";

const API_URL = config.agentApiUrl;
const MODEL = config.agentModel;

const SYSTEM_PROMPT = `You are an autonomous Solana bundle retry agent.
You receive failed Jito bundle data and decide the single best corrective action.
Reason step by step. Respond ONLY in this exact format:

REASONING: <your analysis, 2-4 sentences>
ACTION: <refresh_blockhash | increase_tip | wait_next_leader | abort>

Action meanings:
- refresh_blockhash: blockhash expired, fetch fresh and retry
- increase_tip: tip too low, increase by 50% and retry
- wait_next_leader: leader skipped or not Jito-enabled, wait for next window
- abort: non-recoverable error, do not retry`;

export interface AgentFailureContext {
  bundleId: string;
  faultType: string | null;
  rawError: string;
  retryCount: number;
  slotContext: {
    currentSlot: number;
    submitSlot?: number;
  };
  tipLamports: number;
  blockhash?: string;
}

export interface AgentDecision {
  action: AgentAction;
  reasoning: string;
  // True when the action was forced by an API/parse failure (failClosed),
  // NOT by genuine model reasoning. Lets the runner log the difference honestly.
  isSystemFailure: boolean;
}

export async function callAgent(ctx: AgentFailureContext): Promise<AgentDecision> {
  logger.info(`[agent] Calling ${MODEL} - fault=${ctx.faultType ?? "none"} retry=${ctx.retryCount}`);

  let json: any;
  let modelUsed = MODEL;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.agentApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          temperature: 0.1,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Bundle failure:\n\n${JSON.stringify(ctx, null, 2)}\n\nProvide REASONING and ACTION.` },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      json = await res.json();

      if (!res.ok || json.error) {
        const detail = JSON.stringify(json.error ?? json);
        logger.error(`[agent] API HTTP ${res.status}: ${detail}`);
        if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
          await sleep(1_500 * attempt);
          continue;
        }
        return failClosed(ctx, `[API_ERROR] HTTP ${res.status}: ${detail}`, MODEL);
      }

      modelUsed = json.model ?? MODEL;
      break;
    } catch (err: any) {
      logger.error(`[agent] API call attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) {
        await sleep(1_500 * attempt);
        continue;
      }
      return failClosed(ctx, `[REQUEST_ERROR] ${err.message}`, MODEL);
    }
  }

  // Some reasoning models put their answer in message.reasoning instead of
  // message.content. Check both - first non-empty wins.
  const message = json.choices?.[0]?.message ?? {};
  const responseText: string = (message.content || message.reasoning || "").trim();

  if (!responseText) {
    logger.error(`[agent] Empty response from ${modelUsed}. Raw: ${JSON.stringify(json).slice(0, 500)}`);
    return failClosed(ctx, `[EMPTY_RESPONSE] model returned no content. Raw: ${JSON.stringify(json).slice(0, 300)}`, modelUsed);
  }

  const valid: AgentAction[] = ["refresh_blockhash", "increase_tip", "wait_next_leader", "abort"];
  const actionMatch = responseText.match(/ACTION:\s*(refresh_blockhash|increase_tip|wait_next_leader|abort)/i);
  const reasoningMatch = responseText.match(/REASONING:\s*(.+?)(?=ACTION:|$)/is);

  if (!actionMatch) {
    logger.warn(`[agent] No ACTION found in response. Raw response: ${responseText.slice(0, 300)}`);
    return failClosed(ctx, `[NO_ACTION_MATCH] Model responded but didn't follow format. Raw: ${responseText.slice(0, 300)}`, modelUsed);
  }

  const action = actionMatch[1].toLowerCase() as AgentAction;
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : responseText;

  logger.info(`[agent] Decision: ${action}`);
  logger.info(`[agent] Reasoning: ${reasoning.slice(0, 200)}`);

  writeAgentDecision({
    bundleId: ctx.bundleId,
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    faultType: ctx.faultType,
    rawError: ctx.rawError,
    slotContext: ctx.slotContext,
    action,
    reasoning,
    model: modelUsed,
  });

  if (!valid.includes(action)) return { action: "abort", reasoning, isSystemFailure: false };
  return { action, reasoning, isSystemFailure: false };
}

/**
 * Used when the API call or parsing fails outright. Still writes a log entry so
 * the failure is visible in agent-decisions.json - but the reasoning field
 * clearly marks it as a system failure, not a model decision, so it is never
 * mistaken for genuine agent reasoning.
 */
function failClosed(ctx: AgentFailureContext, reason: string, model: string): AgentDecision {
  writeAgentDecision({
    bundleId: ctx.bundleId,
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    faultType: ctx.faultType,
    rawError: ctx.rawError,
    slotContext: ctx.slotContext,
    action: "abort",
    reasoning: reason,
    model,
  });
  return { action: "abort", reasoning: reason, isSystemFailure: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
