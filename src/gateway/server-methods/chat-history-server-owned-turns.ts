import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

// Parses an endpoint session-items response into stored turns for server-owned chat history.

type Item = Record<string, unknown>;
export type StoredTurn = { inputs: Item[]; outputs: Item[] };
export type SessionItemsResponse = {
  items?: Array<{
    version?: number;
    seq?: number;
    is_output?: boolean;
    summary?: boolean;
    content?: unknown;
  }>;
  responses?: Array<{ id?: string; client_id?: string; version?: number; item_count?: number }>;
};

/**
 * Split a stored transcript into turns, keyed by the advertised id when the
 * store matched one. Each compaction starts a new version: a response's
 * `item_count` counts within its own version, and the summary items a
 * compaction wrote are not part of the conversation shown to the user.
 */
export function storedTurnsByResponse(body: SessionItemsResponse): Map<string, StoredTurn> {
  const versionOf = (value: { version?: number }) => value.version ?? 0;
  const turns = new Map<string, StoredTurn>();
  const versions = new Set([...(body.responses ?? [])].map(versionOf));
  for (const version of versions) {
    const items = (body.items ?? [])
      .filter((item) => versionOf(item) === version)
      .toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const responses = (body.responses ?? [])
      .filter((response) => versionOf(response) === version)
      .toSorted((a, b) => (a.item_count ?? 0) - (b.item_count ?? 0));
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
        if (content && item.summary !== true) {
          (item.is_output ? turn.outputs : turn.inputs).push(content);
        }
      }
      turns.set(key, turn);
      start = end;
    }
  }
  return turns;
}
