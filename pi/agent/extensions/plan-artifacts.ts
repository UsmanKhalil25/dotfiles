import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  executionMarker,
  planBaseId,
  planTitle,
  renderPlanArtifact,
  type PlanIndex,
  type PlanRecord,
  type PlanStep,
} from "../plan-artifacts-lib.ts";

const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RPC_PROTOCOL_VERSION = 1;
const PLAN_WIDGET_KEY = "pi-modes-plan";

interface PlanConfig {
  plansDir?: string;
  recentContextLimit?: number;
  contextPreviewChars?: number;
  preserveRevisions?: boolean;
  suppressPlanTransition?: boolean;
  hidePlanProgress?: boolean;
  rpcTimeoutMs?: number;
}

const DEFAULT_CONFIG: Required<PlanConfig> = {
  plansDir: ".plans",
  recentContextLimit: 5,
  contextPreviewChars: 2400,
  preserveRevisions: true,
  // pi-agent-modes@0.3.0 does not expose config for these UI behaviors. The
  // compatibility layer below keeps plan completion a non-interactive handoff.
  suppressPlanTransition: true,
  hidePlanProgress: true,
  rpcTimeoutMs: 10000,
};

type RegistryModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
};

type EventBus = {
  on?: (event: string, handler: (data: unknown) => void) => (() => void) | void;
  emit?: (event: string, data: unknown) => void;
};

function sessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function indexPath(cwd: string, config: Required<PlanConfig>): string {
  return join(resolve(cwd, config.plansDir), "index.json");
}

async function loadConfig(ctx: ExtensionContext): Promise<Required<PlanConfig>> {
  try {
    const raw = await readFile(join(process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent`, "plan-artifacts.json"), "utf8");
    const parsed = JSON.parse(raw) as PlanConfig;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      recentContextLimit: Math.max(1, Math.min(20, parsed.recentContextLimit ?? DEFAULT_CONFIG.recentContextLimit)),
      contextPreviewChars: Math.max(200, Math.min(10000, parsed.contextPreviewChars ?? DEFAULT_CONFIG.contextPreviewChars)),
      rpcTimeoutMs: Math.max(1000, Math.min(120000, parsed.rpcTimeoutMs ?? DEFAULT_CONFIG.rpcTimeoutMs)),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadIndex(cwd: string, config: Required<PlanConfig>): Promise<PlanIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(cwd, config), "utf8")) as Partial<PlanIndex>;
    if (Array.isArray(parsed.records)) {
      return { version: 1, activePlanId: parsed.activePlanId, records: parsed.records as PlanRecord[] };
    }
  } catch {
    // The index is created lazily when the first plan is completed.
  }
  return { version: 1, records: [] };
}

async function saveIndex(cwd: string, config: Required<PlanConfig>, index: PlanIndex): Promise<void> {
  const dir = resolve(cwd, config.plansDir);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(cwd, config), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function latestRecord(index: PlanIndex, id?: string): PlanRecord | undefined {
  const candidates = id ? index.records.filter((record) => record.id === id) : index.records;
  return [...candidates].sort((a, b) => {
    const byTime = b.updatedAt.localeCompare(a.updatedAt);
    return byTime || b.revision - a.revision;
  })[0];
}

function activeRecord(index: PlanIndex): PlanRecord | undefined {
  const active = latestRecord(index, index.activePlanId);
  if (active && !["completed", "failed", "cancelled"].includes(active.status)) return active;
  return [...index.records]
    .filter((record) => ["ready", "revised", "approved", "in_progress"].includes(record.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function bodyWithoutMetadata(markdown: string): string {
  const end = markdown.indexOf("\n---", 4);
  const body = end >= 0 ? markdown.slice(end + 4) : markdown;
  return body.replace(/\n## Tracked steps\n[\s\S]*$/m, "").trim();
}

async function writePlanRevision(
  ctx: ExtensionContext,
  markdown: string,
  steps: PlanStep[],
): Promise<PlanRecord> {
  const config = await loadConfig(ctx);
  const index = await loadIndex(ctx.cwd, config);
  const now = new Date();
  const nowIso = now.toISOString();
  const current = activeRecord(index);
  const title = planTitle(markdown);
  const sameSession = current?.sourceSession === sessionId(ctx);
  const id = sameSession && current ? current.id : planBaseId(now, title);
  const revision = sameSession && current ? current.revision + 1 : 1;
  const filename = `${id}${revision > 1 ? `-r${String(revision).padStart(2, "0")}` : ""}.md`;
  const record: PlanRecord = {
    id,
    title,
    file: filename,
    revision,
    status: revision > 1 ? "revised" : "ready",
    createdAt: sameSession && current ? current.createdAt : nowIso,
    updatedAt: nowIso,
    sourceSession: sessionId(ctx),
    supersedes: sameSession && current ? current.file : undefined,
    steps: steps.map((step) => ({ step: step.step, text: step.text, completed: step.completed === true })),
  };

  index.records.push(record);
  index.activePlanId = id;
  await mkdir(resolve(ctx.cwd, config.plansDir), { recursive: true });
  await writeFile(join(resolve(ctx.cwd, config.plansDir), filename), renderPlanArtifact(record, markdown), "utf8");
  await saveIndex(ctx.cwd, config, index);
  ctx.ui.notify(`Plan saved: ${relative(ctx.cwd, join(resolve(ctx.cwd, config.plansDir), filename))}`, "info");
  return record;
}

async function updateRecord(ctx: ExtensionContext, id: string, patch: Partial<PlanRecord>): Promise<PlanRecord | undefined> {
  const config = await loadConfig(ctx);
  const index = await loadIndex(ctx.cwd, config);
  const record = latestRecord(index, id);
  if (!record) return undefined;
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  const filePath = join(resolve(ctx.cwd, config.plansDir), record.file);
  try {
    const markdown = await readFile(filePath, "utf8");
    await writeFile(filePath, renderPlanArtifact(record, bodyWithoutMetadata(markdown)), "utf8");
  } catch {
    // Keep the index authoritative if a manually removed artifact is encountered.
  }
  index.activePlanId = id;
  await saveIndex(ctx.cwd, config, index);
  return record;
}

async function listRecords(ctx: ExtensionContext): Promise<PlanRecord[]> {
  const config = await loadConfig(ctx);
  const index = await loadIndex(ctx.cwd, config);
  return [...index.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function planContext(ctx: ExtensionContext): Promise<string> {
  const config = await loadConfig(ctx);
  const index = await loadIndex(ctx.cwd, config);
  if (index.records.length === 0) return "";
  const active = activeRecord(index);
  const recent = [...index.records]
    .filter((record) => !active || record.file !== active.file)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, config.recentContextLimit);
  const lines = ["[PROJECT PLAN CONTEXT]", `Plans directory: ${config.plansDir}`];
  if (active) lines.push(`Active plan: ${active.id} (${active.status}, revision ${active.revision}) — ${active.file}`);
  if (active?.executionRunId) {
    lines.push(`Worker: ${active.status} — ${active.executionModel ?? "configured model"} — run ${active.executionRunId}`);
  }
  if (recent.length) {
    lines.push("Recent plans:");
    for (const record of recent) lines.push(`- ${record.id}: ${record.status} — ${record.title} — ${record.file}`);
  }
  if (active) {
    try {
      const markdown = await readFile(join(resolve(ctx.cwd, config.plansDir), active.file), "utf8");
      const preview = bodyWithoutMetadata(markdown).slice(0, config.contextPreviewChars);
      lines.push("", "Active plan preview:", preview);
    } catch {
      lines.push("", "Active plan preview unavailable; use /plans show to inspect it.");
    }
  }
  lines.push("Use /plans list, /plans show <id>, or /plans history <id> for full artifacts.");
  return lines.join("\n");
}

function modeFromBranch(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "pi-modes") continue;
    const data = entry.data as { mode?: unknown } | undefined;
    return typeof data?.mode === "string" ? data.mode : undefined;
  }
  return undefined;
}

function modelId(model: RegistryModel): string {
  return `${model.provider}/${model.id}`;
}

function resolveModel(models: RegistryModel[], hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const normalized = hint.toLowerCase().replace(/:/g, "/");
  const exact = models.find((model) => modelId(model).toLowerCase() === normalized || model.id.toLowerCase() === normalized);
  if (exact) return modelId(exact);
  const matches = models.filter((model) => modelId(model).toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized));
  return matches.length === 1 ? modelId(matches[0]) : undefined;
}

function modelItems(models: RegistryModel[], prefix = ""): AutocompleteItem[] {
  const normalized = prefix.toLowerCase();
  return models
    .map((model) => ({
      value: modelId(model),
      label: modelId(model),
      description: model.name || (model.reasoning ? "reasoning model" : "available model"),
    }))
    .filter((item) => item.value.toLowerCase().startsWith(normalized));
}

function planItems(records: PlanRecord[], prefix = ""): AutocompleteItem[] {
  const values = ["latest", ...records.map((record) => record.id)];
  const normalized = prefix.toLowerCase();
  return [...new Set(values)]
    .filter((value) => value.toLowerCase().startsWith(normalized))
    .map((value) => ({ value, label: value, description: value === "latest" ? "active project plan" : "project plan artifact" }));
}

export function subagentCompletions(prefix: string, models: RegistryModel[], records: PlanRecord[]): AutocompleteItem[] | null {
  const hasTrailingSpace = /\s$/.test(prefix);
  const parts = prefix.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
    const modelPrefix = parts[0] ?? "";
    const modelMatches = modelItems(models, modelPrefix);
    return modelMatches.length > 0 ? modelMatches : null;
  }
  const planPrefix = hasTrailingSpace ? "" : parts[1] ?? "";
  const planMatches = planItems(records, planPrefix);
  return planMatches.length > 0 ? planMatches : null;
}

export function isPlanTransitionPrompt(title: string, choices: readonly string[]): boolean {
  return title.startsWith("Plan mode") && choices.some((choice) => choice.startsWith("Execute the plan"));
}

export function shouldSuppressPlanWidget(key: string): boolean {
  return key === PLAN_WIDGET_KEY;
}

function installPlanUiCompatibility(ctx: ExtensionContext, config: Required<PlanConfig>): () => void {
  if (!ctx.hasUI || (!config.suppressPlanTransition && !config.hidePlanProgress)) return () => {};
  const ui = ctx.ui as unknown as {
    select?: (...args: any[]) => Promise<any>;
    setWidget?: (...args: any[]) => any;
    setStatus?: (...args: any[]) => any;
  };
  const originalSelect = ui.select;
  const originalSetWidget = ui.setWidget;
  const originalSetStatus = ui.setStatus;
  if (config.suppressPlanTransition && originalSelect) {
    ui.select = async (title: string, choices: readonly string[], ...rest: unknown[]) => {
      if (isPlanTransitionPrompt(title, choices)) return "Stay in plan mode";
      return originalSelect.call(ctx.ui, title, choices, ...rest);
    };
  }
  if (config.hidePlanProgress && originalSetWidget) {
    // Clear a widget restored by pi-agent-modes before this compatibility layer
    // was installed, then suppress future progress updates.
    originalSetWidget.call(ctx.ui, PLAN_WIDGET_KEY, undefined);
    ui.setWidget = (key: string, value: unknown, ...rest: unknown[]) => {
      if (shouldSuppressPlanWidget(key)) return originalSetWidget.call(ctx.ui, key, undefined, ...rest);
      return originalSetWidget.call(ctx.ui, key, value, ...rest);
    };
  }
  if (config.hidePlanProgress && originalSetStatus) {
    originalSetStatus.call(ctx.ui, PLAN_WIDGET_KEY, undefined);
    ui.setStatus = (key: string, value: unknown, ...rest: unknown[]) => {
      if (shouldSuppressPlanWidget(key)) return originalSetStatus.call(ctx.ui, key, undefined, ...rest);
      return originalSetStatus.call(ctx.ui, key, value, ...rest);
    };
  }
  return () => {
    if (originalSelect) ui.select = originalSelect;
    if (originalSetWidget) ui.setWidget = originalSetWidget;
    if (originalSetStatus) ui.setStatus = originalSetStatus;
  };
}

function parseSubagentArgs(args: string, records: PlanRecord[]): { model?: string; planId?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "go") parts.pop();
  if (parts.length === 0) return {};
  if (parts[0].toLowerCase() === "latest") return { planId: "latest" };
  const firstIsPlan = records.some((record) => record.id === parts[0] || record.file === parts[0] || record.id.startsWith(parts[0]));
  if (firstIsPlan) return { planId: parts[0] };
  return { model: parts[0], planId: parts[1] && parts[1] !== "latest" ? parts[1] : "latest" };
}

function rpcRequest(pi: ExtensionAPI, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const events = (pi as unknown as { events?: EventBus }).events;
  if (!events?.on || !events.emit) return Promise.reject(new Error("pi-subagents RPC bridge is not available; reload Pi after installing pi-subagents."));
  const requestId = `plan-worker-${Date.now()}-${randomUUID()}`;
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
    const cleanup = () => {
      if (typeof unsubscribe === "function") unsubscribe();
      clearTimeout(timer);
    };
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const unsubscribe = events.on(replyEvent, (raw) => {
      const reply = raw as { success?: boolean; data?: unknown; error?: { message?: string } };
      if (reply.success) finish(resolveRequest, reply.data);
      else finish(rejectRequest, new Error(reply.error?.message || "pi-subagents RPC request failed"));
    });
    const timer = setTimeout(() => finish(rejectRequest, new Error(`pi-subagents RPC timed out after ${timeoutMs}ms`)), timeoutMs);
    events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: RPC_PROTOCOL_VERSION,
      requestId,
      method,
      params,
      source: { extension: "plan-artifacts" },
    });
  });
}

function completionStatus(payload: unknown): "completed" | "failed" | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as { success?: unknown; state?: unknown; results?: unknown };
  if (value.success === false || ["failed", "stopped", "paused", "rejected"].includes(String(value.state))) return "failed";
  if (value.success === true || ["complete", "completed"].includes(String(value.state))) return "completed";
  if (Array.isArray(value.results) && value.results.some((result) => result && typeof result === "object" && (result as { success?: unknown }).success === false)) return "failed";
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | undefined;
  let models: RegistryModel[] = [];
  let latestPlanRecords: PlanRecord[] = [];
  let restoreUi: (() => void) | undefined;

  const events = (pi as unknown as { events?: EventBus }).events;
  events?.on?.(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
    const ctx = currentContext;
    if (!ctx || !payload || typeof payload !== "object") return;
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId !== "string") return;
    void (async () => {
      const config = await loadConfig(ctx);
      const index = await loadIndex(ctx.cwd, config);
      const record = index.records.find((item) => item.executionRunId === runId);
      if (!record) return;
      const status = completionStatus(payload);
      if (status) await updateRecord(ctx, record.id, { status, executionCompletedAt: new Date().toISOString() });
    })();
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    models = (ctx.modelRegistry.getAvailable?.() ?? []) as RegistryModel[];
    latestPlanRecords = await listRecords(ctx);
    const config = await loadConfig(ctx);
    restoreUi?.();
    restoreUi = installPlanUiCompatibility(ctx, config);
  });

  pi.on("session_shutdown", () => {
    restoreUi?.();
    restoreUi = undefined;
    currentContext = undefined;
    models = [];
    latestPlanRecords = [];
  });

  pi.on("model_select", (_event, ctx) => {
    models = (ctx.modelRegistry.getAvailable?.() ?? []) as RegistryModel[];
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "pi_modes_plan_complete") return;
    const details = event.details as { plan?: unknown; steps?: unknown } | undefined;
    if (typeof details?.plan !== "string" || !Array.isArray(details.steps)) return;
    const steps = details.steps.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const value = step as { step?: unknown; text?: unknown; completed?: unknown };
      if (typeof value.step !== "number" || typeof value.text !== "string") return [];
      return [{ step: value.step, text: value.text, completed: value.completed === true }];
    });
    await writePlanRevision(ctx, details.plan, steps);
    latestPlanRecords = await listRecords(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const context = await planContext(ctx);
    if (!context) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const text = message.content
      .filter((block): block is { type: string; text: string } => Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"))
      .map((block) => block.text)
      .join("\n");
    const status = executionMarker(text);
    if (!status) return;
    const config = await loadConfig(ctx);
    const index = await loadIndex(ctx.cwd, config);
    const active = activeRecord(index);
    if (!active || active.status !== "in_progress") return;
    await updateRecord(ctx, active.id, { status, executionCompletedAt: new Date().toISOString() });
  });

  pi.registerCommand("plans", {
    description: "List, inspect, revise, approve, and track project plans",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts.shift() || "list";
      const records = await listRecords(ctx);
      if (action === "list" || action === "latest") {
        const selected = action === "latest" ? records.slice(0, 1) : records;
        ctx.ui.notify(selected.length ? selected.map((record) => `${record.id}  ${record.status}  ${record.title}`).join("\n") : "No project plans found.", "info");
        return;
      }
      const config = await loadConfig(ctx);
      const id = parts.shift();
      const record = id ? records.find((item) => item.id === id || item.file === id || item.id.startsWith(id)) : activeRecord(await loadIndex(ctx.cwd, config));
      if (!record) {
        ctx.ui.notify("Plan not found. Use /plans list.", "warning");
        return;
      }
      if (action === "show") {
        const markdown = await readFile(join(resolve(ctx.cwd, config.plansDir), record.file), "utf8");
        ctx.ui.notify(markdown, "info");
        return;
      }
      if (action === "history") {
        ctx.ui.notify(records.filter((item) => item.id === record.id).map((item) => `${item.file}  ${item.status}  revision ${item.revision}`).join("\n"), "info");
        return;
      }
      if (action === "approve") {
        await updateRecord(ctx, record.id, { status: "approved", approvedAt: new Date().toISOString() });
        ctx.ui.notify(`Approved plan ${record.id}.`, "info");
        return;
      }
      if (action === "revise") {
        if (modeFromBranch(ctx) !== "plan") {
          ctx.ui.notify("Plan revisions are only available in Plan mode.", "warning");
          return;
        }
        const feedback = parts.join(" ").trim();
        if (!feedback) {
          ctx.ui.notify("Usage: /plans revise <feedback>", "warning");
          return;
        }
        await pi.sendUserMessage(`Revise the current plan using this feedback:\n\n${feedback}\n\nRemain in Plan mode and submit the revised plan through pi_modes_plan_complete.`, { deliverAs: "followUp" });
        return;
      }
      ctx.ui.notify("Usage: /plans [list|latest|show <id>|history <id>|approve <id>|revise <feedback>]", "info");
    },
  });

  pi.registerCommand("sub-agent", {
    description: "Start one detached plan-worker using a selected model and project plan",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      return subagentCompletions(prefix, models, latestPlanRecords);
    },
    handler: async (args, ctx) => {
      if (!["build", "debug", "yolo"].includes(modeFromBranch(ctx) || "")) {
        ctx.ui.notify("Switch to Build mode before starting a plan worker.", "warning");
        return;
      }
      const config = await loadConfig(ctx);
      const index = await loadIndex(ctx.cwd, config);
      const records = [...index.records];
      latestPlanRecords = records;
      const parsed = parseSubagentArgs(args, records);
      const record = parsed.planId && parsed.planId !== "latest" ? latestRecord(index, parsed.planId) : activeRecord(index);
      if (!record) {
        ctx.ui.notify("No active plan found. Use /plans list or complete a plan first.", "warning");
        return;
      }
      if (!["ready", "revised", "approved"].includes(record.status)) {
        ctx.ui.notify(`Plan ${record.id} is ${record.status}; only ready, revised, or approved plans can start.`, "warning");
        return;
      }

      let model = resolveModel((ctx.modelRegistry.getAvailable?.() ?? []) as RegistryModel[], parsed.model);
      if (!parsed.model && ctx.hasUI) {
        const available = ((ctx.modelRegistry.getAvailable?.() ?? []) as RegistryModel[]).map(modelId);
        const selected = await ctx.ui.select("Select worker model", available);
        model = resolveModel((ctx.modelRegistry.getAvailable?.() ?? []) as RegistryModel[], selected || undefined);
      }
      if (!model) {
        ctx.ui.notify(ctx.hasUI ? "No worker model selected. Usage: /sub-agent <provider/model> [plan-id]." : "A worker model is required in non-TUI mode. Usage: /sub-agent <provider/model> [plan-id].", "warning");
        return;
      }

      const planPath = join(resolve(ctx.cwd, config.plansDir), record.file);
      const previousStatus = record.status;
      await updateRecord(ctx, record.id, {
        status: "in_progress",
        approvedAt: record.approvedAt || new Date().toISOString(),
        executionStartedAt: new Date().toISOString(),
        executionCompletedAt: undefined,
        executionModel: model,
        executionRunId: undefined,
        executionAsyncDir: undefined,
      });
      try {
        const response = await rpcRequest(pi, "spawn", {
          agent: "plan-worker",
          task: [
            "Implement the approved project plan.",
            `Read the exact plan file first: ${planPath}`,
            `Work only in this project directory: ${ctx.cwd}`,
            "Use a fresh context, do not create another sub-agent, and report changed files, validation, and unresolved issues.",
            "End with [PLAN_EXECUTION_STATUS: completed] or [PLAN_EXECUTION_STATUS: failed].",
          ].join("\n"),
          context: "fresh",
          cwd: ctx.cwd,
          model,
          async: true,
          artifacts: true,
        }, config.rpcTimeoutMs);
        const details = response?.details ?? response ?? {};
        const runId = typeof details.runId === "string" ? details.runId : typeof details.asyncId === "string" ? details.asyncId : undefined;
        const asyncDir = typeof details.asyncDir === "string" ? details.asyncDir : undefined;
        if (!runId) throw new Error("pi-subagents did not return an async run id");
        await updateRecord(ctx, record.id, { executionRunId: runId, executionAsyncDir: asyncDir });
        latestPlanRecords = await listRecords(ctx);
        ctx.ui.notify(`Started detached plan worker for ${record.id} with ${model} (run ${runId}).`, "info");
      } catch (error) {
        await updateRecord(ctx, record.id, { status: previousStatus, executionRunId: undefined, executionAsyncDir: undefined });
        latestPlanRecords = await listRecords(ctx);
        ctx.ui.notify(`Could not start plan worker: ${(error as Error).message}`, "error");
      }
    },
  });
}
