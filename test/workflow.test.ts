import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReloadingWorkflow, WorkflowError, parseWorkflow, renderPrompt, resolveServiceConfig } from "../src/workflow.js";

const raw = {
  tracker: { kind: "linear", api_key: "$TEST_LINEAR_KEY", project_slug: "demo" },
  workspace: { root: "./workspaces" },
};

test("workflow parsing resolves explicit environment references and workspace paths", () => {
  process.env.TEST_LINEAR_KEY = "test-token";
  const config = resolveServiceConfig(raw, path.join(process.cwd(), "WORKFLOW.md"));
  assert.equal(config.tracker.apiKey, "test-token");
  assert.equal(config.workspace.root, path.resolve(process.cwd(), "workspaces"));
  assert.equal(config.agent.maxConcurrentAgents, 10);
});

test("workflow parser rejects non-map front matter", () => {
  assert.throws(() => parseWorkflow("---\n- no\n---\nbody"), (error: unknown) => error instanceof WorkflowError && error.code === "workflow_front_matter_not_a_map");
});

test("strict Liquid rendering rejects unknown variables", async () => {
  await assert.rejects(renderPrompt("{{ missing }}", { id: "1", identifier: "X-1", title: "x", description: null, priority: null, state: "Todo", branchName: null, url: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null, assigneeId: null }, null));
});

test("workflow reload retains the last valid configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  process.env.TEST_LINEAR_KEY = "test-token";
  await writeFile(workflowPath, "---\ntracker:\n  kind: linear\n  api_key: $TEST_LINEAR_KEY\n  project_slug: demo\n---\nfirst");
  const errors: Error[] = [];
  const source = new ReloadingWorkflow(workflowPath, (error) => errors.push(error));
  assert.equal((await source.get()).promptTemplate, "first");
  await new Promise((resolve) => setTimeout(resolve, 15));
  await writeFile(workflowPath, "---\n- broken\n---\nsecond");
  assert.equal((await source.get()).promptTemplate, "first");
  assert.equal(errors.length, 1);
});
