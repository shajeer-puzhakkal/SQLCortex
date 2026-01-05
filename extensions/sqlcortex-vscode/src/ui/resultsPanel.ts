import * as vscode from "vscode";

export type ResultData = {
  queryId: string;
  executionTimeMs: number;
  rowsReturned: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<unknown>>;
};

export type ResultError = {
  message: string;
  code?: string;
};

export type ResultState =
  | { kind: "success"; data: ResultData }
  | { kind: "error"; error: ResultError };

type WebviewResultData = Omit<ResultData, "queryId">;
type WebviewState =
  | { kind: "success"; data: WebviewResultData }
  | { kind: "error"; error: ResultError };

type WebviewMessage =
  | { type: "ready" }
  | { type: "copyCsv" }
  | { type: "exportCsv" };

export class ResultsPanel {
  private static currentPanel: ResultsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private isReady = false;
  private lastState: ResultState | null = null;

  static show(context: vscode.ExtensionContext): ResultsPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ResultsPanel.currentPanel) {
      ResultsPanel.currentPanel.panel.reveal(column, true);
      return ResultsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "sqlcortex.results",
      "SQLCortex Results",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ResultsPanel.currentPanel = new ResultsPanel(panel, context);
    return ResultsPanel.currentPanel;
  }

  static clearCurrentPanel(panel: ResultsPanel): void {
    if (ResultsPanel.currentPanel === panel) {
      ResultsPanel.currentPanel = undefined;
    }
  }

  private constructor(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext) {
    this.panel = panel;
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

  update(state: ResultState): void {
    this.lastState = state;
    this.postState();
  }

  private postState(): void {
    if (!this.isReady || !this.lastState) {
      return;
    }
    const state = sanitizeState(this.lastState);
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as WebviewMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }

    switch (payload.type) {
      case "ready":
        this.isReady = true;
        this.postState();
        return;
      case "copyCsv":
        await this.copyCsv();
        return;
      case "exportCsv":
        await this.exportCsv();
        return;
      default:
        return;
    }
  }

  private async copyCsv(): Promise<void> {
    const csv = this.buildCsv();
    if (!csv) {
      vscode.window.showWarningMessage("SQLCortex: No results to copy yet.");
      return;
    }
    await vscode.env.clipboard.writeText(csv);
    vscode.window.showInformationMessage("SQLCortex: Results copied as CSV.");
  }

  private async exportCsv(): Promise<void> {
    const csv = this.buildCsv();
    if (!csv) {
      vscode.window.showWarningMessage("SQLCortex: No results to export yet.");
      return;
    }

    const defaultName =
      this.lastState?.kind === "success" && this.lastState.data.queryId
        ? `sqlcortex-${this.lastState.data.queryId}.csv`
        : "sqlcortex-results.csv";
    const baseUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = baseUri
      ? vscode.Uri.joinPath(baseUri, defaultName)
      : vscode.Uri.file(defaultName);

    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { CSV: ["csv"] },
      title: "Export SQLCortex results",
    });

    if (!destination) {
      return;
    }

    const data = new TextEncoder().encode(csv);
    await vscode.workspace.fs.writeFile(destination, data);
    vscode.window.showInformationMessage(`SQLCortex: Results exported to ${destination.fsPath}.`);
  }

  private buildCsv(): string | null {
    if (!this.lastState || this.lastState.kind !== "success") {
      return null;
    }

    const { columns, rows } = this.lastState.data;
    const header = columns.map((col) => escapeCsv(col.name)).join(",");
    const lines = [header];
    for (const row of rows) {
      const line = columns.map((_, idx) => escapeCsv(formatCell(row[idx]))).join(",");
      lines.push(line);
    }
    return lines.join("\n");
  }

  private dispose(): void {
    ResultsPanel.clearCurrentPanel(this);
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
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
    <title>SQLCortex Results</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      body {
        margin: 0;
        padding: 24px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }

      .shell {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .title {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      h1 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }

      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      button {
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }

      .meta-card {
        border-radius: 8px;
        border: 1px solid var(--vscode-panel-border);
        padding: 12px;
        background: var(--vscode-editorWidget-background);
      }

      .meta-label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .meta-value {
        font-size: 18px;
        font-weight: 600;
        margin-top: 6px;
      }

      .table-wrap {
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        overflow: hidden;
        background: var(--vscode-editorWidget-background);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      thead {
        background: var(--vscode-editorWidget-border);
      }

      th,
      td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
        text-align: left;
        vertical-align: top;
        word-break: break-word;
      }

      th {
        font-weight: 600;
        font-size: 12px;
      }

      .col-type {
        display: block;
        margin-top: 4px;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      tbody tr:nth-child(even) td {
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      }

      .empty,
      .error {
        padding: 16px;
        border-radius: 8px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .error {
        border-color: var(--vscode-inputValidation-errorBorder);
        color: var(--vscode-inputValidation-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
      }

      .hidden {
        display: none;
      }

      .is-null {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="header">
        <div class="title">
          <h1>Query Results</h1>
          <p class="subtitle">SQLCortex execution snapshot</p>
        </div>
        <div class="actions">
          <button id="copyCsv">Copy CSV</button>
          <button id="exportCsv" class="secondary">Export CSV</button>
        </div>
      </div>
      <section class="meta">
        <div class="meta-card">
          <div class="meta-label">Execution</div>
          <div class="meta-value" id="execTime">-</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Rows</div>
          <div class="meta-value" id="rowCount">-</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Columns</div>
          <div class="meta-value" id="colCount">-</div>
        </div>
      </section>
      <section id="error" class="error hidden"></section>
      <section id="empty" class="empty hidden">No rows returned.</section>
      <div class="table-wrap">
        <table id="resultsTable"></table>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const execTime = document.getElementById("execTime");
      const rowCount = document.getElementById("rowCount");
      const colCount = document.getElementById("colCount");
      const table = document.getElementById("resultsTable");
      const errorEl = document.getElementById("error");
      const emptyEl = document.getElementById("empty");
      const copyButton = document.getElementById("copyCsv");
      const exportButton = document.getElementById("exportCsv");

      copyButton.addEventListener("click", () => {
        vscode.postMessage({ type: "copyCsv" });
      });
      exportButton.addEventListener("click", () => {
        vscode.postMessage({ type: "exportCsv" });
      });
      setActionsEnabled(false);

      function formatCell(value) {
        if (value === null || value === undefined) {
          return "NULL";
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (typeof value === "object") {
          try {
            return JSON.stringify(value);
          } catch (err) {
            return String(value);
          }
        }
        return String(value);
      }

      function setActionsEnabled(enabled) {
        copyButton.disabled = !enabled;
        exportButton.disabled = !enabled;
      }

      function clearTable() {
        while (table.firstChild) {
          table.removeChild(table.firstChild);
        }
      }

      function renderTable(data) {
        clearTable();
        const head = document.createElement("thead");
        const headerRow = document.createElement("tr");
        data.columns.forEach((column) => {
          const th = document.createElement("th");
          const name = document.createElement("div");
          name.textContent = column.name;
          const type = document.createElement("span");
          type.textContent = column.type || "";
          type.className = "col-type";
          th.appendChild(name);
          if (column.type) {
            th.appendChild(type);
          }
          headerRow.appendChild(th);
        });
        head.appendChild(headerRow);

        const body = document.createElement("tbody");
        data.rows.forEach((row) => {
          const tr = document.createElement("tr");
          data.columns.forEach((_, idx) => {
            const td = document.createElement("td");
            const value = row[idx];
            td.textContent = formatCell(value);
            if (value === null || value === undefined) {
              td.classList.add("is-null");
            }
            tr.appendChild(td);
          });
          body.appendChild(tr);
        });

        table.appendChild(head);
        table.appendChild(body);
      }

      function renderError(state) {
        errorEl.textContent = state.error.message || "Query failed.";
        errorEl.classList.remove("hidden");
        emptyEl.classList.add("hidden");
        clearTable();
        execTime.textContent = "-";
        rowCount.textContent = "-";
        colCount.textContent = "-";
        setActionsEnabled(false);
      }

      function renderSuccess(state) {
        const data = state.data;
        execTime.textContent = data.executionTimeMs + " ms";
        rowCount.textContent = data.rowsReturned.toLocaleString();
        colCount.textContent = data.columns.length.toLocaleString();
        errorEl.classList.add("hidden");
        if (!data.rows.length) {
          emptyEl.classList.remove("hidden");
        } else {
          emptyEl.classList.add("hidden");
        }
        renderTable(data);
        setActionsEnabled(true);
      }

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        if (message.state.kind === "error") {
          renderError(message.state);
        } else {
          renderSuccess(message.state);
        }
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function escapeCsv(value: string): string {
  if (value.includes("\"") || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function sanitizeState(state: ResultState): WebviewState {
  if (state.kind === "error") {
    return state;
  }
  const { queryId: _queryId, ...rest } = state.data;
  return { kind: "success", data: rest };
}

function getNonce(): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}
