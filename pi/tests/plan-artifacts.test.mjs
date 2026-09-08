import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executionMarker,
  planBaseId,
  planTitle,
  renderPlanArtifact,
  slugify,
  utcStamp,
} from "../agent/plan-artifacts-lib.ts";
import planArtifacts, {
  isPlanTransitionPrompt,
  shouldSuppressPlanWidget,
} from "../agent/extensions/plan-artifacts.ts";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

function createEventBus() {
  const handlers = new Map();
  return {
    on(name, handler) {
      const entries = handlers.get(name) ?? new Set();
      entries.add(handler);
      handlers.set(name, entries);
      return () => entries.delete(handler);
    },
    emit(name, value) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(value);
    },
  };
}

test("plan titles become stable readable slugs", () => {
  assert.equal(slugify("Add Pi sub-agent workflow!"), "add-pi-sub-agent-workflow");
  assert.equal(planTitle("# Add Pi sub-agent workflow\n\nDetails"), "Add Pi sub-agent workflow");
});

test("plan IDs sort chronologically", () => {
  const earlier = planBaseId(new Date("2026-08-15T02:48:00.000Z"), "First plan");
  const later = planBaseId(new Date("2026-08-15T03:48:00.000Z"), "Second plan");
  assert.equal(utcStamp(new Date("2026-08-15T02:48:00.000Z")), "20260815T024800Z");
  assert.ok(earlier < later);
});

test("plan artifacts contain auditable metadata and tracked steps", () => {
  const artifact = renderPlanArtifact(
    {
      id: "20260815T024800Z-example-plan",
      title: "Example plan",
      file: "20260815T024800Z-example-plan.md",
      revision: 1,
      status: "ready",
      createdAt: "2026-08-15T02:48:00.000Z",
      updatedAt: "2026-08-15T02:48:00.000Z",
      executionRunId: "run-1",
      executionAsyncDir: "/tmp/run-1",
      steps: [{ step: 1, text: "Implement it", completed: false }],
    },
    "# Example plan\n\nDo the work.",
  );
  assert.match(artifact, /status: "ready"/);
  assert.match(artifact, /revision: 1/);
  assert.match(artifact, /execution_run_id: "run-1"/);
  assert.match(artifact, /- \[ \] 1\. Implement it/);
});

test("execution markers and plan UI compatibility helpers are recognized", () => {
  assert.equal(executionMarker("[PLAN_EXECUTION_STATUS: completed]"), "completed");
  assert.equal(executionMarker("[PLAN_EXECUTION_STATUS: failed]"), "failed");
  assert.equal(executionMarker("no marker"), undefined);
  assert.equal(isPlanTransitionPrompt("Plan mode — what next?", ["Execute the plan (switch to build)", "Stay in plan mode"]), true);
  assert.equal(isPlanTransitionPrompt("Other picker", ["Execute the plan (switch to build)"]), false);
  assert.equal(shouldSuppressPlanWidget("pi-modes-plan"), true);
  assert.equal(shouldSuppressPlanWidget("other-widget"), false);
});

test("extension persists plans, provides model completions, launches one detached worker, and tracks completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plan-artifacts-"));
  const events = new Map();
  const commands = new Map();
  const eventBus = createEventBus();
  const requests = [];
  eventBus.on(RPC_REQUEST_EVENT, (request) => {
    requests.push(request);
    queueMicrotask(() => eventBus.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: { details: { runId: "run-1", asyncId: "run-1", asyncDir: "/tmp/run-1" } },
    }));
  });
  const pi = {
    events: eventBus,
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage() { throw new Error("detached launch must not send a parent follow-up message"); },
  };
  const branch = [{ type: "custom", customType: "pi-modes", data: { mode: "plan" } }];
  const ctx = {
    cwd,
    hasUI: false,
    model: { provider: "test", id: "parent" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "worker", name: "Test worker" }] },
    sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
    ui: { notify() {} },
  };

  try {
    planArtifacts(pi);
    await events.get("session_start")({ reason: "startup" }, ctx);
    await events.get("tool_result")({
      toolName: "pi_modes_plan_complete",
      details: { plan: "# Add the worker\n\nImplement the worker.", steps: [{ step: 1, text: "Implement the worker" }] },
    }, ctx);

    const index = JSON.parse(await readFile(join(cwd, ".plans", "index.json"), "utf8"));
    assert.equal(index.records.length, 1);
    assert.equal(index.records[0].status, "ready");
    assert.match(index.records[0].file, /^\d{8}T\d{6}Z-add-the-worker\.md$/);

    const prompt = await events.get("before_agent_start")({ systemPrompt: "base" }, ctx);
    assert.match(prompt.systemPrompt, /PROJECT PLAN CONTEXT/);
    assert.match(prompt.systemPrompt, /Add the worker/);

    const completions = commands.get("sub-agent").getArgumentCompletions("test/");
    assert.ok(completions.some((item) => item.value === "test/worker"));

    const recordId = index.records[0].id;
    branch[0].data.mode = "build";
    await commands.get("sub-agent").handler(`test/worker ${recordId}`, ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "spawn");
    assert.equal(requests[0].params.agent, "plan-worker");
    assert.equal(requests[0].params.model, "test/worker");
    assert.equal(requests[0].params.cwd, cwd);
    assert.equal(requests[0].params.context, "fresh");
    assert.equal(requests[0].params.async, true);
    assert.match(requests[0].params.task, new RegExp(resolve(cwd, ".plans", index.records[0].file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await readFile(join(cwd, ".plans", "index.json"), "utf8")).includes('"executionRunId": "run-1"'), true);

    eventBus.emit(ASYNC_COMPLETE_EVENT, { runId: "run-1", state: "complete", success: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const finalIndex = JSON.parse(await readFile(join(cwd, ".plans", "index.json"), "utf8"));
    assert.equal(finalIndex.records.find((record) => record.id === recordId).status, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
