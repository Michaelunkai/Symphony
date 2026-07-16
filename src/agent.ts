import { CodexAppServerRunner } from "./app-server.js";
import { renderPrompt } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";
import { Issue, RunResult, ServiceConfig, SessionUpdate } from "./types.js";

export interface AgentRunner {
  run(
    issue: Issue,
    attempt: number | null,
    config: ServiceConfig,
    onUpdate: (update: SessionUpdate) => void,
    signal: AbortSignal,
    shouldContinue: () => Promise<boolean>,
  ): Promise<RunResult>;
  cleanup(issue: Issue, config: ServiceConfig): Promise<void>;
}

export class DefaultAgentRunner implements AgentRunner {
  async run(
    issue: Issue,
    attempt: number | null,
    config: ServiceConfig,
    onUpdate: (update: SessionUpdate) => void,
    signal: AbortSignal,
    shouldContinue: () => Promise<boolean>,
  ): Promise<RunResult> {
    const workspaceManager = new WorkspaceManager(config);
    const workspace = await workspaceManager.ensure(issue);
    try {
      await workspaceManager.beforeRun(workspace);
      const prompt = await renderPrompt(configurableTemplate(config), issue, attempt);
      return await new CodexAppServerRunner().run(issue, workspace.path, prompt, attempt, config, onUpdate, signal, shouldContinue);
    } finally {
      await workspaceManager.afterRun(workspace);
    }
  }

  async cleanup(issue: Issue, config: ServiceConfig): Promise<void> {
    await new WorkspaceManager(config).remove(issue);
  }
}

const templates = new WeakMap<ServiceConfig, string>();

export function bindWorkflowPrompt(config: ServiceConfig, promptTemplate: string): ServiceConfig {
  templates.set(config, promptTemplate);
  return config;
}

function configurableTemplate(config: ServiceConfig): string {
  return templates.get(config) ?? "You are working on an issue from Linear.";
}
