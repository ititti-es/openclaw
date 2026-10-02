import { isDeepStrictEqual } from "node:util";
import { SERVER_OWNED_CONTENT_MARKER } from "@openclaw/ai/transports";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.entry.js";
import {
  readTranscriptMessageRows,
  rewriteTranscriptMessageRows,
} from "../config/sessions/session-accessor.sqlite-transcript-content-prune.js";
import { resolveSessionStoreTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayDetachedWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  fetchServerOwnedSessionTurns,
  overlayServerOwnedContent,
  resolveServerOwnedHistoryRoute,
} from "./server-methods/chat-history-server-owned.js";

/**
 * Removes local copies of message content that a server-owned history route
 * (`compat.responsesPruneLocalContent`) already holds.
 *
 * A message is emptied only when the endpoint returns its content unchanged,
 * through the same join chat.history uses to show it, so nothing is removed
 * that the endpoint cannot give back. Message ids, run ids, roles, block kinds,
 * tool-call ids and names, and thinking blocks (which the endpoint does not
 * return) stay: the transcript keeps its shape, and the last stored turn can
 * still anchor the next request. Sessions that changed recently are skipped so
 * an active run never races the rewrite.
 */

const PRUNE_INTERVAL_MS = 5 * 60_000;
const IDLE_BEFORE_PRUNE_MS = 10 * 60_000;

type Item = Record<string, unknown>;
type StoredTurns = Parameters<typeof overlayServerOwnedContent>[1];

/** The message with its endpoint-held content emptied; undefined when it was already pruned. */
export function hollowServerOwnedMessage(message: Item): Item | undefined {
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

type PruneResult = { sessions: number; messages: number };

async function pruneSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  route: NonNullable<ReturnType<typeof resolveServerOwnedHistoryRoute>>;
  signal?: AbortSignal;
}): Promise<number> {
  const scope = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  const rows = readTranscriptMessageRows(scope);
  const responseIds = rows.flatMap((row) =>
    typeof row.message.responseId === "string" ? [row.message.responseId] : [],
  );
  if (responseIds.length === 0) {
    return 0;
  }
  const turns = await fetchServerOwnedSessionTurns({
    cfg: params.cfg,
    route: params.route,
    sessionId: params.sessionId,
    responseIds,
    signal: params.signal,
  });
  if (!turns) {
    return 0;
  }
  const plan = planServerOwnedContentPrune(
    rows.map((row) => row.message),
    turns,
  );
  const rewrites = plan.flatMap(({ index, message }) => {
    const row = rows[index];
    return row ? [{ row, message }] : [];
  });
  return await rewriteTranscriptMessageRows(scope, rewrites);
}

export async function runServerOwnedHistoryPrune(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  now?: number;
}): Promise<PruneResult> {
  const result: PruneResult = { sessions: 0, messages: 0 };
  const now = params.now ?? Date.now();
  for (const target of resolveSessionStoreTargets(params.config, { allAgents: true })) {
    for (const { sessionKey, entry } of listSessionEntriesCore({
      agentId: target.agentId,
      storePath: target.storePath,
    })) {
      params.assertCurrent?.();
      if (!entry.sessionId || now - (entry.updatedAt ?? now) < IDLE_BEFORE_PRUNE_MS) {
        continue;
      }
      const model = resolveSessionModelRef(params.config, entry, target.agentId);
      const route = resolveServerOwnedHistoryRoute(params.config, model.provider, model.model);
      if (!route?.pruneLocalContent) {
        continue;
      }
      const pruned = await pruneSession({
        cfg: params.config,
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey,
        sessionId: entry.sessionId,
        route,
        signal: params.signal,
      });
      if (pruned > 0) {
        result.sessions += 1;
        result.messages += pruned;
      }
    }
  }
  return result;
}

/** One periodic owner per Gateway; a failing session is retried on the next pass. */
export function startServerOwnedHistoryPruneMaintenance(params: {
  getRuntimeConfig: () => OpenClawConfig;
  onError: (message: string) => void;
  onPruned?: (result: PruneResult) => void;
}): { stop: () => Promise<void> } {
  const abortController = new AbortController();
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    if (stopped || inFlight || isGatewayWorkAdmissionClosed()) {
      return;
    }
    const config = params.getRuntimeConfig();
    const assertCurrent = () => {
      if (stopped || params.getRuntimeConfig() !== config || isGatewayWorkAdmissionClosed()) {
        throw new Error(
          "Server-owned history pruning canceled by a configuration change or shutdown",
        );
      }
    };
    inFlight = runWithGatewayDetachedWorkAdmission(
      async () => {
        const result = await runServerOwnedHistoryPrune({
          config,
          assertCurrent,
          signal: abortController.signal,
        });
        if (result.messages > 0) {
          params.onPruned?.(result);
        }
      },
      "runtime:server-owned-history-prune",
      abortController.signal,
    )
      .catch((error: unknown) => {
        if (!stopped) {
          params.onError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(tick, PRUNE_INTERVAL_MS);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      abortController.abort();
      await inFlight;
    },
  };
}
