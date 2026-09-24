import assert from "node:assert/strict";
import { runAgentTurns } from "../src/agent/runtime.ts";

const messages = [{ role: "user", content: "fixture" }];
const events = [];
const controller = new AbortController();
let calls = 0;
const result = await runAgentTurns({
  runId: "fixture-run",
  messages,
  signal: controller.signal,
  onEvent: (event) => events.push(event),
  invoke: async (transcript) => {
    calls += 1;
    if (calls === 1)
      return {
        content: "先读取明确选择的对象",
        toolCalls: [
          {
            id: "read-1",
            name: "resume_read",
            arguments: '{"id":"entry:one"}',
          },
        ],
      };
    assert.equal(transcript.at(-1).role, "tool");
    assert.match(transcript.at(-1).content, /fixture fact/);
    return {
      content: "已生成待审阅提议",
      toolCalls: [
        { id: "proposal-1", name: "propose_resume_patch", arguments: "{}" },
      ],
    };
  },
  execute: (call) =>
    call.name === "resume_read"
      ? { ok: true, data: { content: "fixture fact" }, truncated: false }
      : {
          ok: true,
          data: { proposalId: "p1" },
          truncated: false,
          proposal: { id: "p1" },
        },
});
assert.equal(calls, 2);
assert.deepEqual(result.proposals, [{ id: "p1" }]);
assert.deepEqual(
  events.map(({ seq }) => seq),
  events.map((_, index) => index + 1),
);
assert.equal(events.at(-1).type, "run.completed");

const streamingEvents = [];
let finishStreaming;
const streamingReply = new Promise((resolve) => {
  finishStreaming = resolve;
});
const streamingRun = runAgentTurns({
  runId: "streaming",
  messages,
  signal: new AbortController().signal,
  onEvent: (event) => streamingEvents.push(event),
  invoke: async (_transcript, _signal, onDelta) => {
    onDelta("第一段");
    await streamingReply;
    onDelta("第二段");
    return { content: "第一段第二段", toolCalls: [] };
  },
  execute: () => {
    throw new Error("unexpected tool");
  },
});
assert.deepEqual(
  streamingEvents.filter((event) => event.type === "message.delta").map((event) => event.detail),
  ["第一段"],
);
finishStreaming();
const streamingResult = await streamingRun;
assert.equal(streamingResult.text, "第一段第二段");
assert.deepEqual(
  streamingEvents.filter((event) => event.type === "message.delta").map((event) => event.detail),
  ["第一段", "第二段"],
);

let executed = 0;
await assert.rejects(
  runAgentTurns({
    runId: "duplicate",
    messages,
    signal: new AbortController().signal,
    invoke: async () => ({
      content: "",
      toolCalls: [
        { id: "same", name: "resume_read", arguments: "{}" },
        { id: "same", name: "propose_resume_patch", arguments: "{}" },
      ],
    }),
    execute: () => {
      executed += 1;
      return { ok: true, data: null, truncated: false };
    },
  }),
  /重复/,
);
assert.equal(executed, 0);

const cancelled = new AbortController();
await assert.rejects(
  runAgentTurns({
    runId: "cancelled",
    messages,
    signal: cancelled.signal,
    invoke: async () => {
      cancelled.abort();
      return {
        content: "",
        toolCalls: [
          { id: "late", name: "propose_resume_patch", arguments: "{}" },
        ],
      };
    },
    execute: () => {
      throw new Error("late tool executed");
    },
  }),
  /Aborted/,
);

let budgetCalls = 0;
await assert.rejects(
  runAgentTurns({
    runId: "budget",
    messages,
    signal: new AbortController().signal,
    invoke: async () => ({
      content: "",
      toolCalls: [
        { id: `call-${++budgetCalls}`, name: "resume_read", arguments: "{}" },
      ],
    }),
    execute: () => ({ ok: false, code: "OUT_OF_SCOPE", message: "fixture" }),
  }),
  /6 次模型调用上限/,
);
assert.equal(budgetCalls, 6);
console.log(
  JSON.stringify({
    pass: true,
    checks: [
      "bounded multi-turn read to proposal",
      "ordered run events",
      "incremental text before provider completion without duplication",
      "duplicate call IDs rejected",
      "late cancellation discards tools",
      "model call budget",
    ],
  }),
);
