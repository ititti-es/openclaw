import { describe, expect, it } from "vitest";
import { storedTurnsByResponse } from "./server-methods/chat-history-server-owned-turns.js";
import { overlayServerOwnedContent } from "./server-methods/chat-history-server-owned.js";
import { planServerOwnedContentPrune } from "./server-owned-history-prune-plan.js";

const MARKER = "serverOwnedContent";
const PLACEHOLDER = "(Stored on the model gateway. Not available right now.)";

function userInput(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistantOutput(text: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

const turns = storedTurnsByResponse({
  items: [
    { seq: 0, is_output: false, content: userInput("question") },
    {
      seq: 1,
      is_output: true,
      content: { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
    },
    {
      seq: 2,
      is_output: false,
      content: { type: "function_call_output", call_id: "call_1", output: "tool output" },
    },
    { seq: 3, is_output: true, content: assistantOutput("answer") },
    { seq: 4, is_output: false, content: userInput("edited elsewhere") },
    { seq: 5, is_output: true, content: assistantOutput("second answer") },
  ],
  responses: [
    { id: "resp_1", item_count: 2 },
    { id: "resp_2", item_count: 4 },
    { id: "resp_3", item_count: 6 },
  ],
});

const local: Array<Record<string, unknown>> = [
  { role: "user", content: "question", __openclaw: { id: "u1" } },
  {
    role: "assistant",
    responseId: "resp_1",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
      { type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: { q: "x" } },
    ],
    __openclaw: { id: "a1", runId: "run_1" },
  },
  {
    role: "toolResult",
    toolCallId: "call_1|fc_1",
    content: [{ type: "text", text: "tool output" }],
    __openclaw: { id: "t1" },
  },
  {
    role: "assistant",
    responseId: "resp_2",
    content: [{ type: "text", text: "answer" }],
    __openclaw: { id: "a2" },
  },
  { role: "user", content: "second question", __openclaw: { id: "u2" } },
  {
    role: "assistant",
    responseId: "resp_3",
    content: [{ type: "text", text: "second answer" }],
    __openclaw: { id: "a3" },
  },
  { role: "user", content: "pending", __openclaw: { id: "u3" } },
];

function applyPlan(messages: Array<Record<string, unknown>>) {
  const next = [...messages];
  for (const { index, message } of planServerOwnedContentPrune(messages, turns)) {
    next[index] = message;
  }
  return next;
}

describe("server-owned history pruning", () => {
  it("empties only content the endpoint returns unchanged", () => {
    const plan = planServerOwnedContentPrune(local, turns);

    // u2 differs from the stored text and u3 has no stored turn: both stay.
    expect(plan.map(({ index }) => index)).toEqual([0, 1, 2, 3, 5]);
  });

  it("keeps ids, tool-call names and thinking, and marks the message", () => {
    const planned = new Map(
      planServerOwnedContentPrune(local, turns).map(({ index, message }) => [index, message]),
    );
    const hollow = planned.get(1);

    expect(hollow).toEqual({
      role: "assistant",
      responseId: "resp_1",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: {} },
      ],
      __openclaw: { id: "a1", runId: "run_1" },
      [MARKER]: true,
    });
    expect(planned.get(0)).toMatchObject({ content: "", [MARKER]: true });
  });

  it("gives back every emptied message's content through the chat history join", () => {
    const pruned = applyPlan(local);
    const shown = overlayServerOwnedContent(pruned, turns).messages as Array<
      Record<string, unknown>
    >;

    for (const index of [0, 1, 2, 3, 5]) {
      expect(shown[index]?.content).toEqual(local[index]?.content);
    }
    expect(planServerOwnedContentPrune(pruned, turns)).toEqual([]);
  });

  it("says so when the endpoint cannot give emptied content back", () => {
    const pruned = applyPlan(local);
    const shown = overlayServerOwnedContent(pruned, new Map()).messages as Array<
      Record<string, unknown>
    >;

    expect(shown[0]?.content).toBe(PLACEHOLDER);
    expect(shown[3]?.content).toEqual([{ type: "text", text: PLACEHOLDER }]);
    expect(shown[4]).toBe(pruned[4]);
  });
});
