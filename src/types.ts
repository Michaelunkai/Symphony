export interface Blocker {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: Blocker[];
  createdAt: string | null;
  updatedAt: string | null;
  assigneeId: string | null;
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
  assigneeId: string | null;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  codex: {
    command: string;
    approvalPolicy: unknown;
    threadSandbox: unknown;
    turnSandboxPolicy: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface Workflow extends WorkflowDefinition {
  serviceConfig: ServiceConfig;
  path: string;
}

export interface SessionUpdate {
  event: string;
  timestamp: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  codexAppServerPid?: number;
  message?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  rateLimits?: unknown;
}

export interface RunResult {
  outcome: "succeeded" | "failed" | "timed_out" | "stalled" | "canceled";
  error?: string;
  sessionId?: string;
  runtimeMs: number;
}

export interface StructuredLogger {
  log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}
