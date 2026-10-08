import { isDeepStrictEqual } from "node:util";
import { SERVER_OWNED_CONTENT_MARKER } from "@openclaw/ai/transports";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { overlayServerOwnedContent } from "./server-methods/chat-history-server-owned.js";

// Pure planning half of server-owned history pruning; the maintenance loop that applies it lives in
// server-owned-history-prune.ts.

type Item = Record<string, unknown>;
type StoredTurns = Parameters<typeof overlayServerOwnedContent>[1];

/** The message with its endpoint-held content emptied; undefined when it was already pruned. */
function hollowServerOwnedMessage(message: Item): Item | undefined {
  if (message[SERVER_OWNED_CONTENT_MARKER] === true) {
    return undefined;
  }
  const content = message.content;
  const hollow =
    typeof content === "string"
      ? ""
      : Array.isArray(content)
        ? content.map((block) => {
            const record = asOptionalRecord(block);
            if (record?.type === "text") {
              return { ...record, text: "" };
            }
            if (record?.type === "toolCall") {
              return { ...record, arguments: {} };
            }
            return block;
          })
        : content;
  return { ...message, content: hollow, [SERVER_OWNED_CONTENT_MARKER]: true };
}

/**
 * The local messages to empty, each with its emptied form: those whose content
 * the endpoint returns unchanged. Content it returns differently, or not at
 * all, stays local.
 */
export function planServerOwnedContentPrune(
  messages: readonly Item[],
  turns: StoredTurns,
): Array<{ index: number; message: Item }> {
  const served = overlayServerOwnedContent(messages, turns);
  return served.replacedIndices.flatMap((index) => {
    const local = messages[index];
    const fromEndpoint = asOptionalRecord(served.messages[index]);
    if (!local || !isDeepStrictEqual(fromEndpoint?.content, local.content)) {
      return [];
    }
    const message = hollowServerOwnedMessage(local);
    return message ? [{ index, message }] : [];
  });
}
