import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerRunner } from "../src/app-server.js";
import { Issue, ServiceConfig } from "../src/types.js";

const config: ServiceConfig = {
  tracker: { kind: "linear", endpoint: "https://example.invalid", apiKey: "x", projectSlug: "demo", requiredLabels: [], activeStates: ["Todo"], terminalStates: ["Done"], assigneeId: null },
  polling: { intervalMs: 30000 },
  workspace: { root: process.cwd() },
  hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
  agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: {} },
  codex: { command: "node test/fake-app-server.mjs", approvalPolicy: undefined, threadSandbox: undefined, turnSandboxPolicy: undefined, turnTimeoutMs: 1000, readTimeoutMs: 1000, stallTimeoutMs: 0 },
};
const issue: Issue = { id: "1", identifier: "ABC-1", title: "test", description: null, priority: null, state: "Todo", branchName: null, url: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null, assigneeId: null };

test("Codex app-server runner handles an immediate turn completion notification", async () => {
  const events: string[] = [];
  const result = await new CodexAppServerRunner().run(
    issue,
    process.cwd(),
    "work",
    null,
    config,
    (update) => events.push(update.event),
    new AbortController().signal,
    async () => false,
  );
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.sessionId, "thread-1-turn-1");
  assert.ok(events.includes("turn/completed"));
});
