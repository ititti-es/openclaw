import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripInternalRuntimeContext } from "../../agents/internal-runtime-context.js";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth-provider.js";
import { stripUserEnvelopeForDisplay } from "../../auto-reply/reply/user-envelope-display.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Chat history for sessions whose model route owns conversation history
 * (`compat.responsesHistoryOwnedByServer`).
 *
 * Content comes from the endpoint's session store. OpenClaw contributes only
 * its own metadata: message ids, run ids, idempotency keys, display hints and
 * local-only messages. The local page is the skeleton: each assistant turn is
 * joined to the stored response it produced by `responseId`, and the user
 * messages and tool results before it are joined, in order, to that
 * response's input items. Anything that cannot be joined exactly keeps its
 * local content, so a partial or unreachable store never hides history.
 *
 * The store keys turns by the provider's own response id, while OpenClaw holds
 * the id the endpoint advertised (which a gateway may encrypt). The request
 * names the advertised ids on the page, and the endpoint returns each stored
 * response it matched with that id as `client_id`.
 */

const SESSION_ITEMS_TIMEOUT_MS = 5_000;

type Item = Record<string, unknown>;
export type StoredTurn = { inputs: Item[]; outputs: Item[] };
type SessionItemsResponse = {
  items?: Array<{ seq?: number; is_output?: boolean; content?: unknown }>;
  responses?: Array<{ id?: string; client_id?: string; item_count?: number }>;
};

export type ServerOwnedHistoryRoute = { provider: string; modelId: string; baseUrl: string };

export function resolveServerOwnedHistoryRoute(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
): ServerOwnedHistoryRoute | undefined {
  const providers = asOptionalRecord(asOptionalRecord(cfg.models)?.providers);
  const providerConfig = asOptionalRecord(providers?.[provider]);
  const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const model = models
    .map((entry) => asOptionalRecord(entry))
    .find((entry) => entry?.id === modelId);
  const compat = asOptionalRecord(model?.compat);
  if (
    compat?.responsesHistoryOwnedByServer !== true ||
    compat.supportsResponsesContinuation !== true
  ) {
    return undefined;
  }
  const baseUrl =
    typeof model?.baseUrl === "string"
      ? model.baseUrl
      : typeof providerConfig?.baseUrl === "string"
        ? providerConfig.baseUrl
        : undefined;
  return baseUrl ? { provider, modelId, baseUrl } : undefined;
}

export async function fetchServerOwnedSessionTurns(params: {
  cfg: OpenClawConfig;
  route: ServerOwnedHistoryRoute;
  sessionId: string;
  responseIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, StoredTurn> | undefined> {
  const auth = await resolveApiKeyForProviderCore({
    provider: params.route.provider,
    cfg: params.cfg,
    modelId: params.route.modelId,
    modelBaseUrl: params.route.baseUrl,
    signal: params.signal,
  });
  if (!auth.apiKey) {
    return undefined;
  }
  const baseUrl = params.route.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/sessions/${encodeURIComponent(params.sessionId)}/items`;
  const timeout = AbortSignal.timeout(SESSION_ITEMS_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ response_ids: params.responseIds }),
    signal: params.signal ? AbortSignal.any([params.signal, timeout]) : timeout,
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`session store returned HTTP ${response.status}`);
  }
  return storedTurnsByResponse((await response.json()) as SessionItemsResponse);
}

/** Split a stored transcript into turns, keyed by the advertised id when the store matched one. */
export function storedTurnsByResponse(body: SessionItemsResponse): Map<string, StoredTurn> {
  const items = [...(body.items ?? [])].toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const responses = [...(body.responses ?? [])].toSorted(
    (a, b) => (a.item_count ?? 0) - (b.item_count ?? 0),
  );
  const turns = new Map<string, StoredTurn>();
  let start = 0;
  for (const response of responses) {
    const end = response.item_count ?? start;
    const key = response.client_id ?? response.id;
    if (typeof key !== "string" || end <= start) {
      continue;
    }
    const turn: StoredTurn = { inputs: [], outputs: [] };
    for (const item of items.slice(start, end)) {
      const content = asOptionalRecord(item.content);
      if (content) {
        (item.is_output ? turn.outputs : turn.inputs).push(content);
      }
    }
    turns.set(key, turn);
    start = end;
  }
  return turns;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    const record = asOptionalRecord(part);
    return typeof record?.text === "string" ? [record.text] : [];
  });
}

/** User-visible text of a stored user input, or undefined for a pure runtime-context carrier. */
function storedUserText(item: Item): string | undefined {
  if (item.type !== "message" || item.role !== "user") {
    return undefined;
  }
  // The model saw the delivery envelope (timestamp, channel); the transcript shows the bare text.
  const sent = stripInternalRuntimeContext(textParts(item.content).join("\n")).trim();
  const text = stripUserEnvelopeForDisplay(sent).trim();
  return text.length > 0 ? text : undefined;
}

function storedToolOutput(item: Item): string | undefined {
  if (item.type !== "function_call_output") {
    return undefined;
  }
  return typeof item.output === "string" ? item.output : textParts(item.output).join("\n");
}

/** Replace the single text block (or string content) of a message; anything else stays local. */
function withText(message: Item, text: string): Item | undefined {
  if (typeof message.content === "string") {
    return { ...message, content: text };
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const textBlocks = message.content.filter((block) => asOptionalRecord(block)?.type === "text");
  if (textBlocks.length !== 1) {
    return undefined;
  }
  return {
    ...message,
    content: message.content.map((block) => {
      const record = asOptionalRecord(block);
      return record?.type === "text" ? { ...record, text } : block;
    }),
  };
}

function parsedArguments(call: Item, fallback: unknown): unknown {
  if (typeof call.arguments !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(call.arguments);
  } catch {
    return fallback;
  }
}

/**
 * Rebuild an assistant message from the stored response, keeping the local
 * block order and ids: text blocks take the stored output text in order and
 * tool calls take the stored name and arguments in order. A shape mismatch
 * keeps the local message.
 */
function withAssistantOutput(message: Item, outputs: Item[]): Item | undefined {
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const texts = outputs
    .filter((item) => item.type === "message" && item.role === "assistant")
    .map((item) => textParts(item.content).join(""));
  const calls = outputs.filter((item) => item.type === "function_call");
  const kinds = message.content.map((block) => asOptionalRecord(block)?.type);
  if (
    kinds.filter((kind) => kind === "text").length !== texts.length ||
    kinds.filter((kind) => kind === "toolCall").length !== calls.length
  ) {
    return undefined;
  }
  let textIndex = 0;
  let callIndex = 0;
  return {
    ...message,
    content: message.content.map((block) => {
      const record = asOptionalRecord(block);
      if (record?.type === "text") {
        return { ...record, text: texts[textIndex++] ?? "" };
      }
      if (record?.type === "toolCall") {
        const call = calls[callIndex++] ?? {};
        return {
          ...record,
          ...(typeof call.name === "string" ? { name: call.name } : {}),
          arguments: parsedArguments(call, record.arguments),
        };
      }
      return block;
    }),
  };
}

function markServerContent(message: Item): Item {
  // `__openclaw` is the gateway's own metadata envelope on transcript messages.
  const metaKey = "__openclaw";
  const meta = asOptionalRecord(message[metaKey]) ?? {};
  return { ...message, [metaKey]: { ...meta, contentSource: "server" } };
}

/**
 * Replace message content with the stored turns' content. The page keeps its
 * order, count and every local-only message.
 */
export function overlayServerOwnedContent(
  messages: readonly unknown[],
  turns: ReadonlyMap<string, StoredTurn>,
): { messages: unknown[]; replaced: number } {
  const result = [...messages];
  let replaced = 0;
  const replaceAt = (index: number, next: Item | undefined) => {
    if (next) {
      result[index] = markServerContent(next);
      replaced += 1;
    }
  };
  let segment: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const message = asOptionalRecord(result[index]);
    if (!message) {
      continue;
    }
    if (message.role !== "assistant") {
      if (message.role === "user" || message.role === "toolResult") {
        segment.push(index);
      }
      continue;
    }
    const pending = segment;
    segment = [];
    const turn = typeof message.responseId === "string" ? turns.get(message.responseId) : undefined;
    if (!turn) {
      continue;
    }
    replaceAt(index, withAssistantOutput(message, turn.outputs));
    const roleAt = (i: number) => asOptionalRecord(result[i])?.role;
    const localUsers = pending.filter((i) => roleAt(i) === "user");
    const localTools = pending.filter((i) => roleAt(i) === "toolResult");
    const storedUsers = turn.inputs.flatMap((item) => storedUserText(item) ?? []);
    const storedTools = turn.inputs.flatMap((item) => storedToolOutput(item) ?? []);
    if (localUsers.length === storedUsers.length) {
      localUsers.forEach((i, n) =>
        replaceAt(i, withText(asOptionalRecord(result[i]) ?? {}, storedUsers[n] ?? "")),
      );
    }
    if (localTools.length === storedTools.length) {
      localTools.forEach((i, n) =>
        replaceAt(i, withText(asOptionalRecord(result[i]) ?? {}, storedTools[n] ?? "")),
      );
    }
  }
  return { messages: result, replaced };
}

/**
 * Apply the stored content to a history page when the session's route owns
 * history. Store failures degrade to the local page and are logged at debug.
 */
export async function overlayServerOwnedHistoryPage<TPage extends { messages: unknown[] }>(
  cfg: OpenClawConfig,
  model: { provider: string; model: string },
  sessionId: string | undefined,
  page: TPage,
  context: { logGateway: { debug: (message: string) => void } },
  signal?: AbortSignal,
): Promise<TPage> {
  const route = resolveServerOwnedHistoryRoute(cfg, model.provider, model.model);
  if (!route || !sessionId || page.messages.length === 0) {
    return page;
  }
  const log = context.logGateway;
  const responseIds = page.messages.flatMap((message) => {
    const responseId = asOptionalRecord(message)?.responseId;
    return typeof responseId === "string" ? [responseId] : [];
  });
  if (responseIds.length === 0) {
    return page;
  }
  try {
    const turns = await fetchServerOwnedSessionTurns({
      cfg,
      route,
      sessionId,
      responseIds,
      signal,
    });
    if (!turns) {
      log.debug(`chat history: no stored session for provider=${route.provider}`);
      return page;
    }
    const overlay = overlayServerOwnedContent(page.messages, turns);
    log.debug(
      `chat history: server-owned content provider=${route.provider} ` +
        `replaced=${overlay.replaced}/${page.messages.length}`,
    );
    return { ...page, messages: overlay.messages };
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    log.debug(`chat history: session store unavailable provider=${route.provider}: ${reason}`);
    return page;
  }
}
