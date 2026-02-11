import * as vscode from "vscode";
import type { DbCopilotAuditLogEntry } from "../dbcopilot/bottomPanelState";

type WebviewMessage = { type: "ready" } | { type: "exportJson" };

export class DbCopilotAgentLogsPanel {
  private static currentPanel: DbCopilotAgentLogsPanel | undefined;

  private panel?: vscode.WebviewPanel;
  private isReady = false;
  private entries: DbCopilotAuditLogEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  static show(): DbCopilotAgentLogsPanel {
    if (!DbCopilotAgentLogsPanel.currentPanel) {
      DbCopilotAgentLogsPanel.currentPanel = new DbCopilotAgentLogsPanel();
    }
    DbCopilotAgentLogsPanel.currentPanel.reveal();
    return DbCopilotAgentLogsPanel.currentPanel;
  }

  private constructor() {}

  setEntries(entries: DbCopilotAuditLogEntry[]): void {
    this.entries = [...entries];
    this.postState();
  }

  private reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "dbcopilot.agentLogs",
      "Agent Logs (inspectable JSON)",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables
    );
  }

  private dispose(): void {
    if (DbCopilotAgentLogsPanel.currentPanel === this) {
      DbCopilotAgentLogsPanel.currentPanel = undefined;
    }
    this.panel = undefined;
    this.isReady = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private postState(): void {
    if (!this.panel || !this.isReady) {
      return;
    }
    void this.panel.webview.postMessage({ type: "state", entries: this.entries });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as WebviewMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "ready") {
      this.isReady = true;
      this.postState();
      return;
    }
    if (payload.type === "exportJson") {
      await this.exportJson();
    }
  }

  private async exportJson(): Promise<void> {
    if (!this.entries.length) {
      vscode.window.showWarningMessage("DB Copilot: No agent logs to export.");
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder, "dbcopilot-agent-logs.json")
      : undefined;

    const destination = await vscode.window.showSaveDialog({
      filters: { JSON: ["json"] },
      defaultUri,
      title: "Export agent logs",
    });
    if (!destination) {
      return;
    }

    const content = `${JSON.stringify(this.entries, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(destination, Buffer.from(content, "utf8"));
    vscode.window.showInformationMessage(
      `DB Copilot: Agent logs exported to ${destination.fsPath}.`
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent Logs (inspectable JSON)</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      body {
        margin: 0;
        padding: 16px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        box-sizing: border-box;
      }

      .shell {
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: 100%;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .actions {
        display: flex;
        gap: 8px;
      }

      button {
        border: none;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .grid {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 12px;
        flex: 1;
        min-height: 0;
      }

      .list {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        background: var(--vscode-editorWidget-background);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px;
        min-height: 240px;
      }

      .list-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid transparent;
        cursor: pointer;
        background: color-mix(
          in srgb,
          var(--vscode-editorWidget-background) 90%,
          transparent
        );
      }

      .list-item.active {
        border-color: var(--vscode-focusBorder);
        background: color-mix(
          in srgb,
          var(--vscode-editorWidget-background) 75%,
          var(--vscode-focusBorder) 25%
        );
      }

      .list-meta {
        display: flex;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .list-message {
        font-size: 12px;
      }

      .empty {
        padding: 16px;
        border-radius: 10px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .json {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        background: var(--vscode-editorWidget-background);
        padding: 12px;
        overflow-y: auto;
        min-height: 240px;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
      }

      details {
        margin-left: 12px;
      }

      summary {
        cursor: pointer;
        list-style: none;
      }

      summary::marker {
        display: none;
      }

      summary::before {
        content: "▸";
        display: inline-block;
        width: 12px;
        margin-right: 4px;
      }

      details[open] summary::before {
        content: "▾";
      }

      .node {
        margin-left: 16px;
        border-left: 1px dashed var(--vscode-panel-border);
        padding-left: 8px;
      }

      .leaf {
        margin-left: 16px;
      }

      .key {
        color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground));
      }

      .value {
        color: var(--vscode-terminal-ansiBrightBlue);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>Agent Logs (inspectable JSON)</h1>
        <div class="actions">
          <button id="exportJson">Export JSON</button>
        </div>
      </header>
      <div class="grid">
        <div id="logList" class="list"></div>
        <div id="jsonView" class="json"></div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const logList = document.getElementById("logList");
      const jsonView = document.getElementById("jsonView");
      const exportButton = document.getElementById("exportJson");

      let entries = [];
      let activeIndex = -1;

      function formatTimestamp(value) {
        if (!value) {
          return "";
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }

      function setActive(index) {
        activeIndex = index;
        renderList();
        renderJson();
      }

      function renderList() {
        logList.innerHTML = "";
        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No agent logs yet.";
          logList.appendChild(empty);
          return;
        }
        entries.forEach((entry, index) => {
          const item = document.createElement("div");
          item.className = "list-item" + (index === activeIndex ? " active" : "");
          item.addEventListener("click", () => setActive(index));

          const meta = document.createElement("div");
          meta.className = "list-meta";
          meta.textContent = "[" + formatTimestamp(entry.timestamp) + "] " + (entry.agent || "");

          const message = document.createElement("div");
          message.className = "list-message";
          message.textContent = entry.message || "";

          item.appendChild(meta);
          item.appendChild(message);
          logList.appendChild(item);
        });
      }

      function renderJson() {
        jsonView.innerHTML = "";
        if (!entries.length || activeIndex < 0 || activeIndex >= entries.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Select a log entry to inspect JSON.";
          jsonView.appendChild(empty);
          return;
        }
        const entry = entries[activeIndex];
        const root = buildNode("log", entry, true);
        jsonView.appendChild(root);
      }

      function buildNode(label, value, isRoot) {
        const type = Object.prototype.toString.call(value);
        const isObject = value && typeof value === "object";

        if (!isObject) {
          const leaf = document.createElement("div");
          leaf.className = "leaf";
          leaf.innerHTML = '<span class="key">' + label + ':</span> <span class="value">' + formatValue(value) + "</span>";
          return leaf;
        }

        const details = document.createElement("details");
        details.open = Boolean(isRoot);
        const summary = document.createElement("summary");
        summary.innerHTML =
          '<span class="key">' +
          label +
          "</span> " +
          '<span class="value">' +
          describeValue(value, type) +
          "</span>";
        details.appendChild(summary);

        const container = document.createElement("div");
        container.className = "node";
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            container.appendChild(buildNode(String(index), item, false));
          });
        } else {
          Object.keys(value).forEach((key) => {
            container.appendChild(buildNode(key, value[key], false));
          });
        }
        details.appendChild(container);
        return details;
      }

      function describeValue(value, type) {
        if (Array.isArray(value)) {
          return "[Array " + value.length + "]";
        }
        if (type === "[object Object]") {
          return "{Object " + Object.keys(value).length + "}";
        }
        return type;
      }

      function formatValue(value) {
        if (typeof value === "string") {
          return JSON.stringify(value);
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        if (value === null || typeof value === "undefined") {
          return "null";
        }
        return JSON.stringify(value);
      }

      exportButton.addEventListener("click", () => {
        vscode.postMessage({ type: "exportJson" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        entries = Array.isArray(message.entries) ? message.entries : [];
        if (entries.length && activeIndex === -1) {
          activeIndex = 0;
        } else if (activeIndex >= entries.length) {
          activeIndex = entries.length - 1;
        }
        renderList();
        renderJson();
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}
