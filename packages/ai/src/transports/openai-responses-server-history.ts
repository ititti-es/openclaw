import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { resolveOpenAIResponsesPayloadPolicy } from "./openai-responses-payload-policy.js";

/**
 * Request context for a route whose endpoint owns conversation history
 * (`compat.responsesHistoryOwnedByServer`).
 *
 * The continuation point is the last completed assistant turn this route
 * answered, read from the transcript itself rather than from process memory,
 * so it survives gateway restarts and idle periods. Everything after that turn
 * (the new user message, tool results, per-turn context) is the only history
 * sent; the endpoint replays the rest from its own store.
 *
 * The context still starts at the anchor turn: tool results are only
 * converted when the tool call they answer is present, so dropping the anchor
 * would silently drop its tool results. Its own output items are removed from
 * the converted input instead (see `dropAnchorOutputItems`).
 */
export type ServerOwnedHistoryRequest = {
  context: Context;
  previousResponseId: string;
};

export function usesServerOwnedResponsesHistory(model: Model): boolean {
  const compat = model.compat as { responsesHistoryOwnedByServer?: boolean } | undefined;
  return (
    compat?.responsesHistoryOwnedByServer === true &&
    resolveOpenAIResponsesPayloadPolicy(model).explicitContinuationOptIn
  );
}

function isContinuableTurn(message: AssistantMessage, model: Model): boolean {
  return (
    typeof message.responseId === "string" &&
    message.responseId.length > 0 &&
    message.provider === model.provider &&
    message.api === model.api &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

export function resolveServerOwnedHistoryRequest(
  model: Model,
  context: Context,
): ServerOwnedHistoryRequest | undefined {
  if (!usesServerOwnedResponsesHistory(model)) {
    return undefined;
  }
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    if (!isContinuableTurn(message, model)) {
      // A failed or foreign turn was never stored as a continuation point here.
      return undefined;
    }
    if (index === context.messages.length - 1) {
      return undefined;
    }
    return {
      context: { ...context, messages: context.messages.slice(index) },
      previousResponseId: message.responseId as string,
    };
  }
  return undefined;
}

const ANCHOR_OUTPUT_ITEM_TYPES = new Set(["reasoning", "function_call", "custom_tool_call"]);

/**
 * Remove the items converted from the anchor assistant turn: the endpoint
 * already holds them as the output of `previous_response_id`.
 */
export function dropAnchorOutputItems<T>(input: T): T {
  if (!Array.isArray(input)) {
    return input;
  }
  let start = 0;
  while (start < input.length) {
    const item = input[start] as { type?: unknown; role?: unknown } | undefined;
    const isAnchorOutput =
      (typeof item?.type === "string" && ANCHOR_OUTPUT_ITEM_TYPES.has(item.type)) ||
      (item?.role === "assistant" && (item.type === "message" || item.type === undefined));
    if (!isAnchorOutput) {
      break;
    }
    start += 1;
  }
  return input.slice(start) as T;
}
