import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { Issue, RunResult, ServiceConfig, SessionUpdate } from "./types.js";

type JsonRpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

export class CodexAppServerRunner {
  async run(
    issue: Issue,
    workspacePath: string,
    prompt: string,
    attempt: number | null,
    config: ServiceConfig,
    onUpdate: (update: SessionUpdate) => void,
    signal: AbortSignal,
    shouldContinue: () => Promise<boolean>,
  ): Promise<RunResult> {
    const started = Date.now();
    const child = spawn("bash", ["-lc", config.codex.command], { cwd: workspacePath, stdio: "pipe" });
    const client = new JsonRpcClient(child, config.codex.readTimeoutMs, onUpdate);
    const abort = () => {
      void client.request("turn/interrupt", client.threadId ? { threadId: client.threadId } : {}).catch(() => undefined);
      child.kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.initialize();
      await client.startThread(workspacePath, config);
      for (let turn = 0; turn < config.agent.maxTurns; turn += 1) {
        const input = turn === 0
          ? prompt
          : `Continue working on ${issue.identifier}. Inspect the current state, make the next concrete progress, validate it, and update the issue according to the workflow.`;
        const completed = await client.startTurn(input, workspacePath, config, signal);
        if (!completed) return { outcome: "failed", error: "Codex reported a failed turn", sessionId: client.sessionId, runtimeMs: Date.now() - started };
        if (turn + 1 < config.agent.maxTurns && !(await shouldContinue())) break;
      }
      return { outcome: "succeeded", sessionId: client.sessionId, runtimeMs: Date.now() - started };
    } catch (error) {
      return {
        outcome: signal.aborted ? "canceled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        sessionId: client.sessionId,
        runtimeMs: Date.now() - started,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      child.kill();
    }
  }
}

class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private turnCompletion: { resolve: (success: boolean) => void; reject: (error: Error) => void } | null = null;
  threadId: string | null = null;
  turnId: string | null = null;
  sessionId: string | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly readTimeoutMs: number,
    private readonly onUpdate: (update: SessionUpdate) => void,
  ) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (data) => this.onUpdate({ event: "app_server_stderr", timestamp: new Date().toISOString(), message: String(data).slice(0, 1000) }));
    child.once("exit", (code) => {
      const error = new Error(`Codex app-server exited with code ${code ?? "unknown"}`);
      for (const request of this.pending.values()) request.reject(error);
      this.turnCompletion?.reject(error);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  async startThread(cwd: string, config: ServiceConfig): Promise<void> {
    const params: Record<string, unknown> = { cwd };
    if (config.codex.approvalPolicy !== undefined) params.approvalPolicy = config.codex.approvalPolicy;
    if (config.codex.threadSandbox !== undefined) params.sandbox = config.codex.threadSandbox;
    const result = await this.request("thread/start", params);
    const thread = result.thread as { id?: unknown } | undefined;
    this.threadId = thread?.id ? String(thread.id) : null;
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id");
  }

  async startTurn(input: string, cwd: string, config: ServiceConfig, signal: AbortSignal): Promise<boolean> {
    if (!this.threadId) throw new Error("cannot start a turn without a thread");
    const params: Record<string, unknown> = { threadId: this.threadId, input: [{ type: "text", text: input }], cwd };
    if (config.codex.turnSandboxPolicy !== undefined) params.sandboxPolicy = config.codex.turnSandboxPolicy;
    const completion = new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex turn timed out")), config.codex.turnTimeoutMs);
      const aborted = () => reject(new Error("Codex turn canceled"));
      signal.addEventListener("abort", aborted, { once: true });
      this.turnCompletion = {
        resolve: (success) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", aborted);
          resolve(success);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      };
    });
    try {
      const started = await this.request("turn/start", params);
      const turn = started.turn as { id?: unknown } | undefined;
      this.turnId = turn?.id ? String(turn.id) : null;
      this.sessionId = this.threadId && this.turnId ? `${this.threadId}-${this.turnId}` : undefined;
      this.onUpdate({ event: "session_started", timestamp: new Date().toISOString(), threadId: this.threadId, turnId: this.turnId ?? undefined, sessionId: this.sessionId, codexAppServerPid: this.child.pid });
      return await completion;
    } catch (error) {
      this.turnCompletion?.reject(error instanceof Error ? error : new Error(String(error)));
      return await completion;
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server read timeout for ${method}`));
      }, this.readTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.onUpdate({ event: "app_server_invalid_json", timestamp: new Date().toISOString(), message: line.slice(0, 1000) });
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message ?? "app-server request failed")) : pending.resolve(message.result ?? {});
      return;
    }
    const event = message.method ?? "app_server_notification";
    const params = message.params ?? {};
    const turn = params.turn as { id?: unknown; status?: unknown; usage?: Record<string, unknown> } | undefined;
    const usage = turn?.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    this.onUpdate({
      event,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      threadId: this.threadId ?? undefined,
      turnId: turn?.id ? String(turn.id) : this.turnId ?? undefined,
      codexAppServerPid: this.child.pid,
      message: typeof params.message === "string" ? params.message.slice(0, 1000) : undefined,
      usage,
      rateLimits: params.rateLimits,
    });
    if (event === "turn/completed") this.turnCompletion?.resolve(true);
    if (event === "turn/failed" || event === "turn/interrupted") this.turnCompletion?.resolve(false);
  }
}
