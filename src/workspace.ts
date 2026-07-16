import { existsSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Issue, ServiceConfig } from "./types.js";

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export const workspaceKey = (identifier: string) => identifier.replace(/[^A-Za-z0-9._-]/g, "_");

function safeWorkspacePath(root: string, identifier: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, workspaceKey(identifier));
  const relative = path.relative(absoluteRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe workspace path");
  return candidate;
}

async function runHook(script: string, cwd: string, timeoutMs: number): Promise<void> {
  const executable = process.platform === "win32" ? "powershell.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", script]
    : ["-lc", script];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("workspace hook timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`workspace hook failed with exit code ${code ?? "unknown"}`));
    });
  });
}

export class WorkspaceManager {
  constructor(private readonly config: Pick<ServiceConfig, "workspace" | "hooks">) {}

  async ensure(issue: Issue): Promise<Workspace> {
    const destination = safeWorkspacePath(this.config.workspace.root, issue.identifier);
    const createdNow = !existsSync(destination);
    await mkdir(destination, { recursive: true });
    if (createdNow && this.config.hooks.afterCreate) await runHook(this.config.hooks.afterCreate, destination, this.config.hooks.timeoutMs);
    return { path: destination, workspaceKey: workspaceKey(issue.identifier), createdNow };
  }

  async beforeRun(workspace: Workspace): Promise<void> {
    if (this.config.hooks.beforeRun) await runHook(this.config.hooks.beforeRun, workspace.path, this.config.hooks.timeoutMs);
  }

  async afterRun(workspace: Workspace): Promise<void> {
    if (!this.config.hooks.afterRun) return;
    try {
      await runHook(this.config.hooks.afterRun, workspace.path, this.config.hooks.timeoutMs);
    } catch {
      // After-run hook failures are intentionally non-fatal.
    }
  }

  async remove(issue: Issue): Promise<void> {
    const destination = safeWorkspacePath(this.config.workspace.root, issue.identifier);
    if (!existsSync(destination)) return;
    if (!(await lstat(destination)).isDirectory()) throw new Error(`workspace path is not a directory: ${destination}`);
    if (this.config.hooks.beforeRemove) {
      try {
        await runHook(this.config.hooks.beforeRemove, destination, this.config.hooks.timeoutMs);
      } catch {
        // Cleanup still proceeds after a before-remove hook failure.
      }
    }
    await rm(destination, { recursive: true, force: true });
  }
}
