import assert from "node:assert/strict";
import test from "node:test";
import { bindWorkflowPrompt, AgentRunner } from "../src/agent.js";
import { Orchestrator, IssueTracker } from "../src/orchestrator.js";
import { Issue, RunResult, ServiceConfig, SessionUpdate, StructuredLogger, Workflow } from "../src/types.js";

const config: ServiceConfig = {
  tracker: { kind: "linear", endpoint: "https://example.invalid", apiKey: "x", projectSlug: "demo", requiredLabels: ["codex"], activeStates: ["Todo", "In Progress"], terminalStates: ["Done"], assigneeId: null },
  polling: { intervalMs: 60000 },
  workspace: { root: "/tmp/symphony" },
  hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
  agent: { maxConcurrentAgents: 1, maxTurns: 2, maxRetryBackoffMs: 300000, maxConcurrentAgentsByState: {} },
  codex: { command: "codex app-server", approvalPolicy: undefined, threadSandbox: undefined, turnSandboxPolicy: undefined, turnTimeoutMs: 1000, readTimeoutMs: 1000, stallTimeoutMs: 0 },
};
bindWorkflowPrompt(config, "{{ issue.identifier }}");
const workflow: Workflow = { config: {}, promptTemplate: "{{ issue.identifier }}", serviceConfig: config, path: "WORKFLOW.md" };
const baseIssue = (id: string, priority: number | null = 1): Issue => ({ id, identifier: `ABC-${id}`, title: id, description: null, priority, state: "Todo", branchName: null, url: null, labels: ["codex"], blockedBy: [], createdAt: `2026-01-0${id}T00:00:00Z`, updatedAt: null, assigneeId: null });

class MemoryLogger implements StructuredLogger {
  events: string[] = [];
  log(_: "debug" | "info" | "warn" | "error", event: string): void { this.events.push(event); }
}

class FakeTracker implements IssueTracker {
  constructor(public issues: Issue[]) {}
  async fetchCandidates(): Promise<Issue[]> { return this.issues; }
  async fetchStates(ids: string[]): Promise<Map<string, Issue>> { return new Map(this.issues.filter((issue) => ids.includes(issue.id)).map((issue) => [issue.id, issue])); }
  async fetchTerminalIssues(): Promise<Issue[]> { return []; }
}

class FakeRunner implements AgentRunner {
  started: string[] = [];
  cleaned: string[] = [];
  resolvers = new Map<string, (result: RunResult) => void>();
  async run(issue: Issue, _: number | null, __: ServiceConfig, onUpdate: (update: SessionUpdate) => void, signal: AbortSignal): Promise<RunResult> {
    this.started.push(issue.id);
    onUpdate({ event: "session_started", timestamp: new Date().toISOString(), usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    onUpdate({ event: "turn_completed", timestamp: new Date().toISOString(), usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    return await new Promise<RunResult>((resolve) => {
      this.resolvers.set(issue.id, resolve);
      signal.addEventListener("abort", () => resolve({ outcome: "canceled", runtimeMs: 1 }), { once: true });
    });
  }
  async cleanup(issue: Issue): Promise<void> { this.cleaned.push(issue.id); }
  finish(id: string, outcome: RunResult["outcome"] = "succeeded"): void { this.resolvers.get(id)?.({ outcome, runtimeMs: 1 }); }
}

test("dispatch uses priority, concurrency, and continuation retries", async () => {
  const tracker = new FakeTracker([baseIssue("2", 2), baseIssue("1", 1)]);
  const runner = new FakeRunner();
  const orchestrator = new Orchestrator(tracker, runner, async () => workflow, new MemoryLogger());
  await orchestrator.tick();
  assert.deepEqual(runner.started, ["1"]);
  runner.finish("1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(orchestrator.snapshot().retries[0]?.attempt, 1);
  orchestrator.stop();
});

test("terminal reconciliation stops the run and removes its workspace", async () => {
  const issue = baseIssue("1");
  const tracker = new FakeTracker([issue]);
  const runner = new FakeRunner();
  const orchestrator = new Orchestrator(tracker, runner, async () => workflow, new MemoryLogger());
  await orchestrator.tick();
  tracker.issues = [{ ...issue, state: "Done" }];
  await orchestrator.tick();
  assert.deepEqual(runner.cleaned, ["1"]);
  assert.deepEqual(orchestrator.snapshot().claimed, []);
  orchestrator.stop();
});

test("usage totals use deltas from cumulative Codex updates", async () => {
  const tracker = new FakeTracker([baseIssue("1")]);
  const runner = new FakeRunner();
  const orchestrator = new Orchestrator(tracker, runner, async () => workflow, new MemoryLogger());
  await orchestrator.tick();
  const entry = runner.resolvers.get("1");
  assert.ok(entry);
  // The fake runner emits 3/2/5 once. Repeated totals should not double count.
  runner.finish("1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(orchestrator.snapshot().totals, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    runtimeMs: 1,
  });
  orchestrator.stop();
});
