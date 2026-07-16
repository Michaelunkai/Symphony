import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceManager, workspaceKey } from "../src/workspace.js";
import { ServiceConfig } from "../src/types.js";

const config = (root: string): Pick<ServiceConfig, "workspace" | "hooks"> => ({
  workspace: { root },
  hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
});

const issue = { id: "1", identifier: "ABC/1", title: "test", description: null, priority: null, state: "Todo", branchName: null, url: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null, assigneeId: null };

test("workspace identifiers are safely normalized and preserved", async () => {
  assert.equal(workspaceKey("ABC/1"), "ABC_1");
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
  const manager = new WorkspaceManager(config(root));
  const first = await manager.ensure(issue);
  assert.equal(first.createdNow, true);
  assert.equal((await manager.ensure(issue)).createdNow, false);
  assert.ok((await stat(first.path)).isDirectory());
  await manager.remove(issue);
});
