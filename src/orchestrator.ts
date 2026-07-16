import { AgentRunner } from "./agent.js";
import { Issue, RunResult, ServiceConfig, SessionUpdate, StructuredLogger, Workflow } from "./types.js";

export interface IssueTracker {
  fetchCandidates(activeStates: string[]): Promise<Issue[]>;
  fetchStates(issueIds: string[]): Promise<Map<string, Issue>>;
  fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]>;
}

interface RunningEntry {
  issue: Issue;
  attempt: number | null;
  startedAt: number;
  lastEventAt: number | null;
  controller: AbortController;
  cancellation: "terminal" | "inactive" | "stalled" | null;
  completion: Promise<void>;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  timer: NodeJS.Timeout;
  error: string | null;
}

export interface RuntimeSnapshot {
  running: Array<{ issueId: string; identifier: string; state: string; sessionAgeMs: number }>;
  claimed: string[];
  retries: Array<{ issueId: string; identifier: string; attempt: number; error: string | null }>;
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; runtimeMs: number };
}

const normalized = (value: string) => value.trim().toLowerCase();
const contains = (states: string[], value: string) => states.some((candidate) => normalized(candidate) === normalized(value));

export class Orchestrator {
  private workflow: Workflow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retries = new Map<string, RetryEntry>();
  private totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, runtimeMs: 0 };

  constructor(
    private readonly tracker: IssueTracker,
    private readonly runner: AgentRunner,
    private readonly getWorkflow: () => Promise<Workflow>,
    private readonly logger: StructuredLogger,
  ) {}

  async start(): Promise<void> {
    this.workflow = await this.getWorkflow();
    await this.startupCleanup(this.workflow.serviceConfig);
    await this.tick();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.running.values()) entry.controller.abort();
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
  }

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickInternal().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  snapshot(): RuntimeSnapshot {
    const now = Date.now();
    return {
      running: [...this.running.entries()].map(([issueId, entry]) => ({ issueId, identifier: entry.issue.identifier, state: entry.issue.state, sessionAgeMs: now - entry.startedAt })),
      claimed: [...this.claimed],
      retries: [...this.retries.values()].map((retry) => ({ issueId: retry.issueId, identifier: retry.identifier, attempt: retry.attempt, error: retry.error })),
      totals: { ...this.totals },
    };
  }

  private async tickInternal(): Promise<void> {
    let workflow: Workflow;
    try {
      workflow = await this.getWorkflow();
      this.workflow = workflow;
    } catch (error) {
      this.logger.log("error", "workflow_validation_failed", { error: String(error) });
      return;
    }
    const config = workflow.serviceConfig;
    await this.reconcile(config);
    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidates(config.tracker.activeStates);
    } catch (error) {
      this.logger.log("error", "candidate_fetch_failed", { error: String(error) });
      return;
    }
    for (const issue of issues.sort(compareIssues)) {
      if (!this.eligible(issue, config) || this.running.has(issue.id) || this.claimed.has(issue.id)) continue;
      if (!this.hasSlot(issue, config)) break;
      this.dispatch(issue, null, workflow);
    }
  }

  private schedule(): void {
    const delay = this.workflow?.serviceConfig.polling.intervalMs ?? 30000;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule();
    }, delay);
  }

  private async startupCleanup(config: ServiceConfig): Promise<void> {
    try {
      const terminal = await this.tracker.fetchTerminalIssues(config.tracker.terminalStates);
      await Promise.all(terminal.map((issue) => this.runner.cleanup(issue, config).catch((error) =>
        this.logger.log("warn", "startup_workspace_cleanup_failed", { issue_id: issue.id, error: String(error) }),
      )));
    } catch (error) {
      this.logger.log("warn", "startup_terminal_fetch_failed", { error: String(error) });
    }
  }

  private async reconcile(config: ServiceConfig): Promise<void> {
    if (!this.running.size) return;
    const now = Date.now();
    if (config.codex.stallTimeoutMs > 0) {
      for (const entry of this.running.values()) {
        const reference = entry.lastEventAt ?? entry.startedAt;
        if (now - reference > config.codex.stallTimeoutMs) {
          entry.cancellation = "stalled";
          entry.controller.abort();
          this.logger.log("warn", "run_stalled", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier });
        }
      }
    }
    let current: Map<string, Issue>;
    try {
      current = await this.tracker.fetchStates([...this.running.keys()]);
    } catch (error) {
      this.logger.log("warn", "reconciliation_fetch_failed", { error: String(error) });
      return;
    }
    for (const [id, entry] of this.running) {
      const issue = current.get(id);
      if (!issue || contains(config.tracker.terminalStates, issue.state)) {
        entry.cancellation = "terminal";
        entry.controller.abort();
        await entry.completion;
        await this.runner.cleanup(entry.issue, config).catch((error) =>
          this.logger.log("warn", "workspace_cleanup_failed", { issue_id: id, error: String(error) }),
        );
      } else if (!contains(config.tracker.activeStates, issue.state)) {
        entry.cancellation = "inactive";
        entry.controller.abort();
      } else {
        entry.issue = issue;
      }
    }
  }

  private eligible(issue: Issue, config: ServiceConfig): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!contains(config.tracker.activeStates, issue.state) || contains(config.tracker.terminalStates, issue.state)) return false;
    if (config.tracker.assigneeId && issue.assigneeId !== config.tracker.assigneeId) return false;
    if (!config.tracker.requiredLabels.every((label) => label && issue.labels.includes(label))) return false;
    if (normalized(issue.state) === "todo" && issue.blockedBy.some((blocker) => !blocker.state || !contains(config.tracker.terminalStates, blocker.state))) return false;
    return true;
  }

  private hasSlot(issue: Issue, config: ServiceConfig): boolean {
    if (this.running.size >= config.agent.maxConcurrentAgents) return false;
    const stateLimit = config.agent.maxConcurrentAgentsByState[normalized(issue.state)] ?? config.agent.maxConcurrentAgents;
    const stateCount = [...this.running.values()].filter((entry) => normalized(entry.issue.state) === normalized(issue.state)).length;
    return stateCount < stateLimit;
  }

  private dispatch(issue: Issue, attempt: number | null, workflow: Workflow): void {
    const config = workflow.serviceConfig;
    this.claimed.add(issue.id);
    const controller = new AbortController();
    const entry: RunningEntry = {
      issue,
      attempt,
      startedAt: Date.now(),
      lastEventAt: null,
      controller,
      cancellation: null,
      completion: Promise.resolve(),
    };
    this.running.set(issue.id, entry);
    entry.completion = this.runner.run(
      issue,
      attempt,
      config,
      (update) => this.observe(issue, entry, update),
      controller.signal,
      async () => {
        const current = await this.tracker.fetchStates([issue.id]);
        const refreshed = current.get(issue.id);
        return Boolean(refreshed && this.eligible(refreshed, config));
      },
    )
      .then((result) => this.complete(issue, entry, result, config))
      .catch((error) => this.complete(issue, entry, { outcome: "failed", error: String(error), runtimeMs: Date.now() - entry.startedAt }, config));
    this.logger.log("info", "run_started", { issue_id: issue.id, issue_identifier: issue.identifier, attempt });
  }

  private observe(issue: Issue, entry: RunningEntry, update: SessionUpdate): void {
    entry.lastEventAt = Date.now();
    this.totals.inputTokens += update.usage?.inputTokens ?? 0;
    this.totals.outputTokens += update.usage?.outputTokens ?? 0;
    this.totals.totalTokens += update.usage?.totalTokens ?? 0;
    this.logger.log("info", "codex_update", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      session_id: update.sessionId,
      codex_event: update.event,
    });
  }

  private complete(issue: Issue, entry: RunningEntry, result: RunResult, config: ServiceConfig): void {
    if (this.running.get(issue.id) !== entry) return;
    this.running.delete(issue.id);
    this.totals.runtimeMs += result.runtimeMs;
    if (entry.cancellation === "terminal" || entry.cancellation === "inactive") {
      this.claimed.delete(issue.id);
      this.logger.log("info", "run_released", { issue_id: issue.id, reason: entry.cancellation });
      return;
    }
    if (result.outcome === "succeeded") {
      this.queueRetry(issue, 1, null, 1000, config);
      return;
    }
    const attempt = Math.max((entry.attempt ?? 0) + 1, 1);
    const delay = Math.min(10000 * (2 ** (attempt - 1)), config.agent.maxRetryBackoffMs);
    this.queueRetry(issue, attempt, result.error ?? result.outcome, delay, config);
  }

  private queueRetry(issue: Issue, attempt: number, error: string | null, delay: number, config: ServiceConfig): void {
    const existing = this.retries.get(issue.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => void this.runRetry(issue.id, config), delay);
    this.retries.set(issue.id, { issueId: issue.id, identifier: issue.identifier, attempt, error, timer });
    this.logger.log("info", "retry_queued", { issue_id: issue.id, issue_identifier: issue.identifier, attempt, delay_ms: delay, error });
  }

  private async runRetry(issueId: string, configAtQueue: ServiceConfig): Promise<void> {
    const retry = this.retries.get(issueId);
    if (!retry) return;
    this.retries.delete(issueId);
    let config = configAtQueue;
    try {
      const workflow = await this.getWorkflow();
      this.workflow = workflow;
      config = workflow.serviceConfig;
    } catch (error) {
      this.logger.log("error", "workflow_validation_failed", { error: String(error) });
      return;
    }
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidates(config.tracker.activeStates);
    } catch (error) {
      this.queueRetry({ id: issueId, identifier: retry.identifier, title: retry.identifier, description: null, priority: null, state: "", branchName: null, url: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null, assigneeId: null }, retry.attempt, String(error), 10000, config);
      return;
    }
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue || !this.eligible(issue, config)) {
      this.claimed.delete(issueId);
      return;
    }
    if (!this.hasSlot(issue, config)) {
      this.queueRetry(issue, retry.attempt, "no available orchestrator slots", 1000, config);
      return;
    }
    const workflow = this.workflow;
    if (!workflow) return;
    this.dispatch(issue, retry.attempt, workflow);
  }
}

function compareIssues(left: Issue, right: Issue): number {
  const priority = (issue: Issue) => issue.priority ?? Number.MAX_SAFE_INTEGER;
  return priority(left) - priority(right)
    || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))
    || left.identifier.localeCompare(right.identifier);
}
