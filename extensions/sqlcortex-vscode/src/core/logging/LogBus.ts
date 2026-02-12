import * as vscode from "vscode";
import type { DbCopilotLogEntry, DbCopilotLogSource } from "../../dbcopilot/bottomPanelState";

function formatTimestamp(value: Date): string {
  const hours = value.getHours().toString().padStart(2, "0");
  const minutes = value.getMinutes().toString().padStart(2, "0");
  const seconds = value.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatError(err: unknown): string {
  if (!err) {
    return "Unknown error";
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export class LogBus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DbCopilotLogEntry>();
  readonly onDidLog = this.emitter.event;

  log(message: string, source: DbCopilotLogSource = "orchestrator"): DbCopilotLogEntry {
    const entry = this.buildEntry(source, message);
    this.emitter.fire(entry);
    return entry;
  }

  error(
    message: string,
    err?: unknown,
    source: DbCopilotLogSource = "orchestrator"
  ): DbCopilotLogEntry {
    const detail = err ? ` ${formatError(err)}` : "";
    const entry = this.buildEntry(source, `${message}${detail}`.trim());
    this.emitter.fire(entry);
    return entry;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private buildEntry(source: DbCopilotLogSource, message: string): DbCopilotLogEntry {
    const timestamp = formatTimestamp(new Date());
    return {
      id: `${timestamp}-${source}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp,
      source,
      message,
    };
  }
}
