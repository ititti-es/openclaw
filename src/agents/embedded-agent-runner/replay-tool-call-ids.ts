import { usesServerOwnedResponsesHistory } from "@openclaw/ai/transports";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { normalizeOpenAIResponsesToolCallIds } from "../embedded-agent-helpers.js";

/**
 * Whether replayed Responses tool calls keep the provider's own ids on this route.
 *
 * An endpoint that owns the history (`compat.responsesHistoryOwnedByServer`) replays each call it
 * stored under the provider's id (Claude `toolu_*`, xAI `call-*-0`) and pairs the next
 * function_call_output with it by that id. Reshaping the output id to OpenAI's `call_*` form
 * leaves the stored call unanswered, and the provider refuses the turn.
 */
export function keepsProviderToolCallIds(model: unknown): boolean {
  return (
    model != null &&
    usesServerOwnedResponsesHistory(model as Parameters<typeof usesServerOwnedResponsesHistory>[0])
  );
}

/** The Responses tool-call id normalization for replay to `model`'s route. */
export function replayToolCallIdNormalizer(
  model: unknown,
): (messages: AgentMessage[]) => AgentMessage[] {
  return keepsProviderToolCallIds(model)
    ? (messages) => messages
    : normalizeOpenAIResponsesToolCallIds;
}
