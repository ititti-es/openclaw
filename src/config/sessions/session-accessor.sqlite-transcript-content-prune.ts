import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";

/**
 * Exact, maintenance-only access to stored transcript message rows, for
 * replacing message content that another store now owns.
 *
 * Rows are read without a lock and rewritten later under the session's
 * exclusive writer, each only if it is still byte-for-byte what was read, so a
 * session that moved on in between is left for the next pass.
 */

type TranscriptContentScope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

export type TranscriptMessageRow = {
  seq: number;
  eventJson: string;
  event: Record<string, unknown>;
  message: Record<string, unknown>;
};

export function readTranscriptMessageRows(scope: TranscriptContentScope): TranscriptMessageRow[] {
  const resolved = resolveSqliteTranscriptScope(scope);
  const read = withOpenClawAgentDatabaseReadOnly((database) => {
    assertSessionTranscriptHot(database.db, resolved.sessionId);
    return readTranscriptEventRows(database, resolved.sessionId);
  }, toDatabaseOptions(resolved));
  if (!read.found) {
    return [];
  }
  return read.value.flatMap((row) => {
    const event = JSON.parse(row.eventJson) as unknown;
    if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
      return [];
    }
    return [{ seq: row.seq, eventJson: row.eventJson, event, message: event.message }];
  });
}

/** Rewrite the given rows' messages; returns how many rows were rewritten. */
export async function rewriteTranscriptMessageRows(
  scope: TranscriptContentScope,
  rewrites: ReadonlyArray<{ row: TranscriptMessageRow; message: Record<string, unknown> }>,
): Promise<number> {
  if (rewrites.length === 0) {
    return 0;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          assertSessionTranscriptHot(database.db, resolved.sessionId);
          rewriteSqliteTranscriptEventRowsInTransaction(
            database,
            resolved,
            rewrites.map(({ row, message }) => ({
              event: { ...row.event, message } as never,
              expectedEventJson: row.eventJson,
              seq: row.seq,
            })),
          );
          return rewrites.length;
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.content-prune" },
      ),
    "session.transcript.message-rewrite",
  );
}
