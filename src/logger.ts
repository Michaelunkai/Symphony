import { appendFile } from "node:fs/promises";
import { StructuredLogger } from "./types.js";

export class JsonLogger implements StructuredLogger {
  constructor(private readonly filePath?: string) {}

  log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
    process.stdout.write(`${line}\n`);
    if (this.filePath) {
      void appendFile(this.filePath, `${line}\n`).catch(() => undefined);
    }
  }
}
