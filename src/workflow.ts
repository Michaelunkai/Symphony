import { stat } from "node:fs/promises";
import path from "node:path";
import { Liquid } from "liquidjs";
import { parse } from "yaml";
import { Issue, ServiceConfig, Workflow, WorkflowDefinition } from "./types.js";

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const state = (value: string) => value.trim().toLowerCase();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectAt = (value: Record<string, unknown>, key: string) => {
  const nested = value[key];
  if (nested === undefined) return {};
  if (!isObject(nested)) throw new WorkflowError("workflow_parse_error", `${key} must be an object`);
  return nested;
};
const list = (value: unknown, fallback: string[]) =>
  value === undefined ? fallback : Array.isArray(value) ? value.map(String) : (() => { throw new WorkflowError("workflow_parse_error", "expected a list"); })();
const integer = (value: unknown, fallback: number, name: string, min = 0) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new WorkflowError("workflow_parse_error", `${name} must be an integer >= ${min}`);
  return parsed;
};
const optionalString = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new WorkflowError("workflow_parse_error", `${name} must be a string`);
  return value;
};

function resolveEnv(value: unknown, name: string): string {
  if (typeof value !== "string") throw new WorkflowError("workflow_parse_error", `${name} must be a string`);
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  return match ? (process.env[match[1]] ?? "") : value;
}

function resolvePath(value: unknown, workflowPath: string): string {
  let raw = resolveEnv(value ?? "/symphony_workspaces", "workspace.root");
  if (raw.startsWith("~")) raw = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", raw.slice(1));
  raw = raw.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => process.env[key] ?? "");
  return path.resolve(path.dirname(workflowPath), raw);
}

export function parseWorkflow(source: string): WorkflowDefinition {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { config: {}, promptTemplate: source.trim() };
  const closing = lines.slice(1).findIndex((line) => line === "---");
  if (closing < 0) throw new WorkflowError("workflow_parse_error", "front matter is missing a closing delimiter");
  let parsed: unknown;
  try {
    parsed = parse(lines.slice(1, closing + 1).join("\n"));
  } catch (error) {
    throw new WorkflowError("workflow_parse_error", `invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new WorkflowError("workflow_front_matter_not_a_map", "workflow front matter must be a map");
  return { config: parsed, promptTemplate: lines.slice(closing + 2).join("\n").trim() };
}

export function resolveServiceConfig(raw: Record<string, unknown>, workflowPath: string): ServiceConfig {
  const tracker = objectAt(raw, "tracker");
  const polling = objectAt(raw, "polling");
  const workspace = objectAt(raw, "workspace");
  const hooks = objectAt(raw, "hooks");
  const agent = objectAt(raw, "agent");
  const codex = objectAt(raw, "codex");
  const trackerKind = tracker.kind === undefined ? "" : String(tracker.kind);
  if (trackerKind !== "linear") throw new WorkflowError("workflow_parse_error", "tracker.kind must be linear");
  const apiKey = resolveEnv(tracker.api_key ?? "$LINEAR_API_KEY", "tracker.api_key");
  const projectSlug = String(tracker.project_slug ?? "").trim();
  const command = String(codex.command ?? "codex app-server").trim();
  if (!apiKey) throw new WorkflowError("workflow_parse_error", "tracker.api_key is missing after environment resolution");
  if (!projectSlug) throw new WorkflowError("workflow_parse_error", "tracker.project_slug is required");
  if (!command) throw new WorkflowError("workflow_parse_error", "codex.command must not be empty");
  const perStateRaw = objectAt(agent, "max_concurrent_agents_by_state");
  const perState = Object.fromEntries(
    Object.entries(perStateRaw)
      .map(([key, value]) => [state(key), Number(value)] as const)
      .filter(([, value]) => Number.isInteger(value) && value > 0),
  );
  return {
    tracker: {
      kind: "linear",
      endpoint: String(tracker.endpoint ?? "https://api.linear.app/graphql"),
      apiKey,
      projectSlug,
      requiredLabels: list(tracker.required_labels, []).map((label) => state(label)),
      activeStates: list(tracker.active_states, ["Todo", "In Progress"]),
      terminalStates: list(tracker.terminal_states, ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]),
      assigneeId: optionalString(tracker.assignee_id, "tracker.assignee_id"),
    },
    polling: { intervalMs: integer(polling.interval_ms, 30000, "polling.interval_ms", 1) },
    workspace: { root: resolvePath(workspace.root, workflowPath) },
    hooks: {
      afterCreate: optionalString(hooks.after_create, "hooks.after_create"),
      beforeRun: optionalString(hooks.before_run, "hooks.before_run"),
      afterRun: optionalString(hooks.after_run, "hooks.after_run"),
      beforeRemove: optionalString(hooks.before_remove, "hooks.before_remove"),
      timeoutMs: integer(hooks.timeout_ms, 60000, "hooks.timeout_ms", 1),
    },
    agent: {
      maxConcurrentAgents: integer(agent.max_concurrent_agents, 10, "agent.max_concurrent_agents", 1),
      maxTurns: integer(agent.max_turns, 20, "agent.max_turns", 1),
      maxRetryBackoffMs: integer(agent.max_retry_backoff_ms, 300000, "agent.max_retry_backoff_ms", 1),
      maxConcurrentAgentsByState: perState,
    },
    codex: {
      command,
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs: integer(codex.turn_timeout_ms, 3600000, "codex.turn_timeout_ms", 1),
      readTimeoutMs: integer(codex.read_timeout_ms, 5000, "codex.read_timeout_ms", 1),
      stallTimeoutMs: integer(codex.stall_timeout_ms, 300000, "codex.stall_timeout_ms", 0),
    },
  };
}

export async function loadWorkflow(workflowPath: string): Promise<Workflow> {
  let source: string;
  try {
    source = await (await import("node:fs/promises")).readFile(workflowPath, "utf8");
  } catch {
    throw new WorkflowError("missing_workflow_file", `cannot read ${workflowPath}`);
  }
  const definition = parseWorkflow(source);
  return { ...definition, serviceConfig: resolveServiceConfig(definition.config, workflowPath), path: path.resolve(workflowPath) };
}

export async function renderPrompt(template: string, issue: Issue, attempt: number | null): Promise<string> {
  const engine = new Liquid({ strictVariables: true, strictFilters: true });
  try {
    return await engine.parseAndRender(template || "You are working on an issue from Linear.", { issue, attempt });
  } catch (error) {
    throw new WorkflowError("template_render_error", error instanceof Error ? error.message : String(error));
  }
}

export class ReloadingWorkflow {
  private knownMtimeMs = -1;
  private current: Workflow | null = null;

  constructor(readonly workflowPath: string, private readonly onReloadError: (error: Error) => void) {}

  async get(): Promise<Workflow> {
    const currentMtimeMs = (await stat(this.workflowPath)).mtimeMs;
    if (!this.current || currentMtimeMs !== this.knownMtimeMs) {
      try {
        const loaded = await loadWorkflow(this.workflowPath);
        this.current = loaded;
        this.knownMtimeMs = currentMtimeMs;
      } catch (error) {
        if (!this.current) throw error;
        this.onReloadError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return this.current;
  }
}
