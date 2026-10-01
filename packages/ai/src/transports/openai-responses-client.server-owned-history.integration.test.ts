import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Matches the identically-named symbol in src/agents/provider-request-config.ts
// (and the sibling local copy in openai-completions.test-support.ts) via the
// global symbol registry, without a packages/ai -> src/agents import.
const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: { allowPrivateNetwork?: boolean },
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

// Real loopback HTTP + SSE server standing in for a self-hosted OpenAI-Responses
// proxy (e.g. OmniRoute). Unlike openai-responses-client.continuation.test.ts,
// nothing here mocks the `openai` SDK: requests leave the process over a real
// socket and come back as real "text/event-stream" bytes, so this proves the
// wire behavior rather than an intercepted SDK call.
class ScriptedResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly script: Array<(request: Record<string, unknown>) => string>;
  private server: Server | undefined;

  constructor(script: Array<(request: Record<string, unknown>) => string>) {
    this.script = script;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const index = this.requests.length;
        this.requests.push(parsed);
        const frame = this.script[index];
        if (!frame) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: `no scripted response for request ${index}` } }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${frame(parsed)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function completedFrame(responseId: string, content: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: content, annotations: [] }],
          role: "assistant",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function customEndpointModel(baseUrl: string): Model<"openai-responses"> {
  const model = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: "omniroute",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: { supportsResponsesContinuation: true, responsesHistoryOwnedByServer: true },
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
}

async function run(
  model: Model<"openai-responses">,
  context: Context,
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
  } as never);
  return stream.result();
}

function assistantTurn(
  model: Model<"openai-responses">,
  responseId: string | undefined,
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(responseId ? { responseId } : {}),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  } as AssistantMessage;
}

describe("server-owned Responses history (loopback server, no SDK mocking)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it("continues from the transcript's last stored turn without any in-memory state", async () => {
    const server = new ScriptedResponsesServer([() => completedFrame("resp_2", "second answer")]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      // A fresh process: nothing cached, only the persisted transcript.
      await run(
        model,
        {
          messages: [
            userMessage("first question", 1),
            userMessage("per-turn context that was never stored", 1),
            assistantTurn(model, "resp_1", "first answer"),
            userMessage("second question", 3),
          ],
          tools: [],
        },
        "server-owned-restart",
      );

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({ previous_response_id: "resp_1", store: true });
      expect(server.requests[0]?.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second question" }],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("sends tool results that answer the stored turn's tool calls", async () => {
    const server = new ScriptedResponsesServer([() => completedFrame("resp_2", "done")]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const toolTurn = {
        ...assistantTurn(model, "resp_1", ""),
        content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } }],
        stopReason: "toolUse",
      } as AssistantMessage;
      await run(
        model,
        {
          messages: [
            userMessage("look it up", 1),
            toolTurn,
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "lookup",
              content: [{ type: "text", text: "tool says hi" }],
              isError: false,
              timestamp: 3,
            },
          ],
          tools: [],
        } as Context,
        "server-owned-tools",
      );

      expect(server.requests[0]).toMatchObject({ previous_response_id: "resp_1" });
      expect(server.requests[0]?.input).toEqual([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: "tool says hi",
        }),
      ]);
    } finally {
      await server.close();
    }
  });

  it("sends the whole transcript on the first turn", async () => {
    const server = new ScriptedResponsesServer([() => completedFrame("resp_1", "first answer")]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      await run(model, { messages: [userMessage("first question", 1)], tools: [] }, "first-turn");

      expect(server.requests[0]).not.toHaveProperty("previous_response_id");
      expect(server.requests[0]?.input).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("falls back to the full transcript when the last turn failed", async () => {
    const server = new ScriptedResponsesServer([() => completedFrame("resp_3", "answer")]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      await run(
        model,
        {
          messages: [
            userMessage("first question", 1),
            assistantTurn(model, "resp_1", "partial", "error"),
            userMessage("retry", 3),
          ],
          tools: [],
        },
        "failed-turn",
      );

      expect(server.requests[0]).not.toHaveProperty("previous_response_id");
      expect((server.requests[0]?.input as unknown[] | undefined)?.length).toBeGreaterThan(1);
    } finally {
      await server.close();
    }
  });

  it("keeps the stateless path for routes that do not own history", async () => {
    const server = new ScriptedResponsesServer([() => completedFrame("resp_2", "answer")]);
    const baseUrl = await server.listen();
    try {
      const model = {
        ...customEndpointModel(baseUrl),
        compat: { supportsResponsesContinuation: true },
      } as Model<"openai-responses">;
      await run(
        model,
        {
          messages: [
            userMessage("first question", 1),
            assistantTurn(model, "resp_1", "first answer"),
            userMessage("second question", 3),
          ],
          tools: [],
        },
        "not-owned",
      );

      expect(server.requests[0]).not.toHaveProperty("previous_response_id");
    } finally {
      await server.close();
    }
  });
});
