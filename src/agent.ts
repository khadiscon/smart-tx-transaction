/**
 * src/agent.ts
 * Hunter Alpha via OpenRouter — reasons about failures, returns one action.
 */

import { config } from "./config";
import { logger, writeAgentDecision, AgentAction, AgentDecisionEntry } from "./logger";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/hunter-alpha";

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
  bundleNumber: number;
  faultType: string | null;
  rawError: string;
  retryCount: number;
  slotContext: {
    currentSlot: number;
    submitSlot?: number;
    isJitoEnabled?: boolean;
    skipDetected?: boolean;
  };
  tipLamports: number;
  blockhash?: string;
}

export async function callHunterAlpha(ctx: AgentFailureContext): Promise<AgentAction> {
  logger.info(`[agent] Calling Hunter Alpha — bundle #${ctx.bundleNumber} fault=${ctx.faultType ?? "none"}`);

  let responseText: string;
  let modelUsed = MODEL;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/smart-tx-stack",
        "X-Title": "smart-tx-stack",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Bundle failure:\n\n${JSON.stringify(ctx, null, 2)}\n\nProvide REASONING and ACTION.` },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const json: any = await res.json();
    responseText = json.choices?.[0]?.message?.content ?? "";
    modelUsed = json.model ?? MODEL;
  } catch (err: any) {
    logger.error(`[agent] OpenRouter call failed: ${err.message}`);
    return "abort";
  }

  const valid: AgentAction[] = ["refresh_blockhash", "increase_tip", "wait_next_leader", "abort"];
  let action: AgentAction = "abort";
  let reasoning = responseText;

  const actionMatch = responseText.match(/ACTION:\s*(refresh_blockhash|increase_tip|wait_next_leader|abort)/i);
  const reasoningMatch = responseText.match(/REASONING:\s*(.+?)(?=ACTION:|$)/is);

  if (actionMatch && valid.includes(actionMatch[1].toLowerCase() as AgentAction)) {
    action = actionMatch[1].toLowerCase() as AgentAction;
  }
  if (reasoningMatch) reasoning = reasoningMatch[1].trim();

  logger.info(`[agent] 🤖 Decision: ${action}`);
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

  return action;
}

export function describeAction(action: AgentAction): string {
  const map: Record<AgentAction, string> = {
    refresh_blockhash: "Fetching fresh blockhash and retrying",
    increase_tip: "Increasing tip by 50% and retrying",
    wait_next_leader: "Waiting for next Jito leader window",
    abort: "Aborting — agent determined retry is not viable",
  };
  return map[action];
}
