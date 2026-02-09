import * as vscode from "vscode";
import type {
  DbCopilotLogEntry,
  DbCopilotRiskImpactState,
  DbCopilotSqlPreviewState,
} from "../dbcopilot/bottomPanelState";

const DBCOPILOT_PANEL_CONTAINER = "dbcopilotPanel";
const SQL_PREVIEW_VIEW_ID = "dbcopilot.sqlPreview";
const RISK_IMPACT_VIEW_ID = "dbcopilot.riskImpact";
const LOGS_VIEW_ID = "dbcopilot.logs";

type SqlPreviewMessage =
  | { type: "ready" }
  | { type: "copySql" }
  | { type: "saveMigration" }
  | { type: "executeSql" };

type RiskImpactMessage = { type: "ready" };
type LogsMessage = { type: "ready" };

export class DbCopilotSqlPreviewView implements vscode.WebviewViewProvider {
  private static currentProvider: DbCopilotSqlPreviewView | undefined;

  private view?: vscode.WebviewView;
  private isReady = false;
  private lastState: DbCopilotSqlPreviewState | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  static register(context: vscode.ExtensionContext): DbCopilotSqlPreviewView {
    const provider = new DbCopilotSqlPreviewView();
    DbCopilotSqlPreviewView.currentProvider = provider;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SQL_PREVIEW_VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    return provider;
  }

  static show(context: vscode.ExtensionContext): DbCopilotSqlPreviewView {
    if (!DbCopilotSqlPreviewView.currentProvider) {
      DbCopilotSqlPreviewView.register(context);
    }
    DbCopilotSqlPreviewView.currentProvider?.reveal();
    return DbCopilotSqlPreviewView.currentProvider!;
  }

  update(state: DbCopilotSqlPreviewState | null): void {
    this.lastState = state;
    this.postState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => this.dispose(), null, this.disposables);
    view.webview.onDidReceiveMessage(
      (message) => void this.handleMessage(message),
      null,
      this.disposables
    );
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(
      `workbench.view.extension.${DBCOPILOT_PANEL_CONTAINER}`
    );
    await vscode.commands.executeCommand("workbench.action.openView", SQL_PREVIEW_VIEW_ID);
  }

  private dispose(): void {
    this.view = undefined;
    this.isReady = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private postState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", state: this.lastState });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as SqlPreviewMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }

    switch (payload.type) {
      case "ready":
        this.isReady = true;
        this.postState();
        return;
      case "copySql":
        await this.copySql();
        return;
      case "saveMigration":
        await this.saveMigration();
        return;
      case "executeSql":
        await this.executeSql();
        return;
      default:
        return;
    }
  }

  private async copySql(): Promise<void> {
    const sql = this.buildSqlForClipboard();
    if (!sql) {
      vscode.window.showWarningMessage("DB Copilot: No SQL to copy yet.");
      return;
    }
    await vscode.env.clipboard.writeText(sql);
    vscode.window.showInformationMessage("DB Copilot: SQL copied to clipboard.");
  }

  private buildSqlForClipboard(): string | null {
    if (!this.lastState) {
      return null;
    }
    const up = this.lastState.upSql?.trim();
    const down = this.lastState.downSql?.trim();
    if (!up && !down) {
      return null;
    }
    const parts: string[] = [];
    if (up) {
      parts.push("-- Up (transactional)", up);
    }
    if (down) {
      if (parts.length) {
        parts.push("");
      }
      parts.push("-- Down", down);
    }
    return parts.join("\n");
  }

  private async saveMigration(): Promise<void> {
    try {
      await vscode.commands.executeCommand("dbcopilot.openMigrationPlan");
    } catch {
      // Ignore if command is unavailable.
    }
    vscode.window.showInformationMessage(
      "DB Copilot: Save as Migration will be available in Phase 6."
    );
  }

  private async executeSql(): Promise<void> {
    if (!this.lastState) {
      vscode.window.showWarningMessage("DB Copilot: No SQL available to execute.");
      return;
    }
    if (this.lastState.mode !== "execution") {
      vscode.window.showWarningMessage("DB Copilot: Execution mode is required.");
      return;
    }
    if (!this.lastState.policyAllowsExecution) {
      const reason = this.lastState.policyReason || "Execution blocked by policy.";
      vscode.window.showWarningMessage(`DB Copilot: ${reason}`);
      return;
    }
    vscode.window.showInformationMessage("DB Copilot: Execute flow coming soon.");
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
    <title>DB Copilot SQL Preview</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      html,
      body {
        height: 100%;
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
        gap: 14px;
        height: 100%;
      }

      header {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .meta-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        border: 1px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
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

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .note {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .note.hidden {
        display: none;
      }

      .empty {
        padding: 16px;
        border-radius: 10px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .empty.hidden {
        display: none;
      }

      .blocks {
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex: 1;
        min-height: 0;
      }

      .block {
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .block-title {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-sideBarTitle-foreground);
      }

      .code {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        line-height: 1.6;
        display: flex;
        flex-direction: column;
        gap: 2px;
        white-space: pre;
      }

      .code-line {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr);
        gap: 8px;
        align-items: flex-start;
      }

      .prefix {
        color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
        font-weight: 600;
      }

      .prefix.down {
        color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
      }

      .code-empty {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>SQL Preview</h1>
        <p class="subtitle">Review generated SQL before saving or executing.</p>
        <div class="meta-row">
          <span class="pill" id="modePill">Mode: -</span>
        </div>
      </header>
      <div class="actions">
        <button id="copySql">Copy SQL</button>
        <button id="saveMigration" class="secondary">Save as Migration</button>
        <button id="executeSql">Execute</button>
      </div>
      <div id="executionNote" class="note hidden"></div>
      <div id="emptyState" class="empty hidden">
        SQL preview will appear after DB Copilot generates a plan.
      </div>
      <div class="blocks">
        <section class="block">
          <div class="block-title">Up (transactional)</div>
          <div id="upBlock" class="code"></div>
        </section>
        <section class="block">
          <div class="block-title">Down</div>
          <div id="downBlock" class="code"></div>
        </section>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const copyButton = document.getElementById("copySql");
      const saveButton = document.getElementById("saveMigration");
      const executeButton = document.getElementById("executeSql");
      const modePill = document.getElementById("modePill");
      const executionNote = document.getElementById("executionNote");
      const emptyState = document.getElementById("emptyState");
      const upBlock = document.getElementById("upBlock");
      const downBlock = document.getElementById("downBlock");

      copyButton.addEventListener("click", () => vscode.postMessage({ type: "copySql" }));
      saveButton.addEventListener("click", () => vscode.postMessage({ type: "saveMigration" }));
      executeButton.addEventListener("click", () => vscode.postMessage({ type: "executeSql" }));

      function formatMode(mode) {
        if (mode === "execution") {
          return "Execution";
        }
        if (mode === "draft") {
          return "Draft";
        }
        return "Read-Only";
      }

      function renderCode(container, sql, prefixClass) {
        container.innerHTML = "";
        if (!sql) {
          const empty = document.createElement("div");
          empty.className = "code-empty";
          empty.textContent = "No SQL yet.";
          container.appendChild(empty);
          return;
        }
        const lines = sql.replace(/\\r\\n/g, "\\n").split("\\n");
        lines.forEach((line) => {
          const row = document.createElement("div");
          row.className = "code-line";
          const prefix = document.createElement("span");
          prefix.className = "prefix " + prefixClass;
          prefix.textContent = "+";
          const text = document.createElement("span");
          text.textContent = line;
          row.appendChild(prefix);
          row.appendChild(text);
          container.appendChild(row);
        });
      }

      function render(state) {
        const hasSql = Boolean(state && (state.upSql || state.downSql));
        copyButton.disabled = !hasSql;
        saveButton.disabled = !hasSql;

        if (!state) {
          modePill.textContent = "Mode: -";
        } else {
          modePill.textContent = "Mode: " + formatMode(state.mode);
        }

        if (!hasSql) {
          emptyState.classList.remove("hidden");
          renderCode(upBlock, "", "");
          renderCode(downBlock, "", "down");
        } else {
          emptyState.classList.add("hidden");
          renderCode(upBlock, state.upSql, "");
          renderCode(downBlock, state.downSql, "down");
        }

        const modeAllows = Boolean(state && state.mode === "execution");
        const policyAllows = Boolean(state && state.policyAllowsExecution);
        const canExecute = hasSql && modeAllows && policyAllows;
        executeButton.disabled = !canExecute;

        let note = "";
        if (!hasSql) {
          note = "Generate SQL to enable actions.";
        } else if (!modeAllows) {
          note = "Execution requires Execution mode.";
        } else if (!policyAllows) {
          note = (state && state.policyReason) || "Execution blocked by policy.";
        }

        if (note) {
          executionNote.textContent = note;
          executionNote.classList.remove("hidden");
        } else {
          executionNote.textContent = "";
          executionNote.classList.add("hidden");
        }
      }

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        render(message.state);
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}

export class DbCopilotRiskImpactView implements vscode.WebviewViewProvider {
  private static currentProvider: DbCopilotRiskImpactView | undefined;

  private view?: vscode.WebviewView;
  private isReady = false;
  private lastState: DbCopilotRiskImpactState | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  static register(context: vscode.ExtensionContext): DbCopilotRiskImpactView {
    const provider = new DbCopilotRiskImpactView();
    DbCopilotRiskImpactView.currentProvider = provider;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(RISK_IMPACT_VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    return provider;
  }

  static show(context: vscode.ExtensionContext): DbCopilotRiskImpactView {
    if (!DbCopilotRiskImpactView.currentProvider) {
      DbCopilotRiskImpactView.register(context);
    }
    DbCopilotRiskImpactView.currentProvider?.reveal();
    return DbCopilotRiskImpactView.currentProvider!;
  }

  update(state: DbCopilotRiskImpactState | null): void {
    this.lastState = state;
    this.postState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => this.dispose(), null, this.disposables);
    view.webview.onDidReceiveMessage(
      (message) => void this.handleMessage(message),
      null,
      this.disposables
    );
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(
      `workbench.view.extension.${DBCOPILOT_PANEL_CONTAINER}`
    );
    await vscode.commands.executeCommand("workbench.action.openView", RISK_IMPACT_VIEW_ID);
  }

  private dispose(): void {
    this.view = undefined;
    this.isReady = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private postState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", state: this.lastState });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as RiskImpactMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "ready") {
      this.isReady = true;
      this.postState();
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
    <title>DB Copilot Risk & Impact</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      html,
      body {
        height: 100%;
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
        gap: 14px;
        height: 100%;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .banner {
        padding: 10px 12px;
        border-radius: 8px;
        background: var(--vscode-inputValidation-warningBackground);
        color: var(--vscode-inputValidation-warningForeground);
        border: 1px solid var(--vscode-inputValidation-warningBorder);
        font-size: 12px;
      }

      .banner.hidden {
        display: none;
      }

      .summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
      }

      .summary.hidden {
        display: none;
      }

      .summary-row {
        display: grid;
        grid-template-columns: 180px minmax(0, 1fr);
        gap: 12px;
        font-size: 12px;
      }

      .summary-label {
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 11px;
      }

      .empty {
        padding: 16px;
        border-radius: 10px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .empty.hidden {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>Risk & Impact</h1>
        <p class="subtitle">Governance and safety summary for the proposed changes.</p>
      </header>
      <div id="banner" class="banner hidden"></div>
      <div id="summary" class="summary hidden"></div>
      <div id="empty" class="empty hidden">Risk summary will appear here.</div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const banner = document.getElementById("banner");
      const summary = document.getElementById("summary");
      const empty = document.getElementById("empty");

      function render(state) {
        if (!state) {
          banner.classList.add("hidden");
          summary.classList.add("hidden");
          empty.classList.remove("hidden");
          summary.innerHTML = "";
          return;
        }

        empty.classList.add("hidden");
        summary.classList.remove("hidden");

        if (state.requiresManualReview) {
          const reason = state.requiresManualReviewReason || "Manual review required.";
          banner.textContent = reason;
          banner.classList.remove("hidden");
        } else {
          banner.classList.add("hidden");
        }

        summary.innerHTML = "";
        const rows = state.summary || [];
        rows.forEach((item) => {
          const row = document.createElement("div");
          row.className = "summary-row";
          const label = document.createElement("div");
          label.className = "summary-label";
          label.textContent = item.label || "";
          const value = document.createElement("div");
          value.textContent = item.value || "";
          row.appendChild(label);
          row.appendChild(value);
          summary.appendChild(row);
        });
      }

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        render(message.state);
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}

export class DbCopilotLogsView implements vscode.WebviewViewProvider {
  private static currentProvider: DbCopilotLogsView | undefined;

  private view?: vscode.WebviewView;
  private isReady = false;
  private entries: DbCopilotLogEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  static register(context: vscode.ExtensionContext): DbCopilotLogsView {
    const provider = new DbCopilotLogsView();
    DbCopilotLogsView.currentProvider = provider;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(LOGS_VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    return provider;
  }

  static show(context: vscode.ExtensionContext): DbCopilotLogsView {
    if (!DbCopilotLogsView.currentProvider) {
      DbCopilotLogsView.register(context);
    }
    DbCopilotLogsView.currentProvider?.reveal();
    return DbCopilotLogsView.currentProvider!;
  }

  setEntries(entries: DbCopilotLogEntry[]): void {
    this.entries = [...entries];
    this.postState();
  }

  appendEntries(entries: DbCopilotLogEntry[]): void {
    if (!entries.length) {
      return;
    }
    this.entries = [...this.entries, ...entries];
    this.postState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => this.dispose(), null, this.disposables);
    view.webview.onDidReceiveMessage(
      (message) => void this.handleMessage(message),
      null,
      this.disposables
    );
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(
      `workbench.view.extension.${DBCOPILOT_PANEL_CONTAINER}`
    );
    await vscode.commands.executeCommand("workbench.action.openView", LOGS_VIEW_ID);
  }

  private dispose(): void {
    this.view = undefined;
    this.isReady = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private postState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", entries: this.entries });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as LogsMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "ready") {
      this.isReady = true;
      this.postState();
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
    <title>DB Copilot Logs</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      html,
      body {
        height: 100%;
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

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .filter {
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--vscode-panel-border);
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-descriptionForeground);
      }

      .filter.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: transparent;
      }

      .log-list {
        flex: 1;
        overflow-y: auto;
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .log-row {
        display: grid;
        grid-template-columns: 82px 120px minmax(0, 1fr);
        gap: 10px;
        font-size: 12px;
        align-items: center;
      }

      .log-time {
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-editor-font-family);
      }

      .log-source {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 2px 6px;
        border-radius: 6px;
        background: color-mix(
          in srgb,
          var(--vscode-editorWidget-background) 84%,
          transparent
        );
        border: 1px solid var(--vscode-panel-border);
        text-align: center;
      }

      .source-orchestrator {
        color: var(--vscode-charts-blue);
      }

      .source-schema_analyst {
        color: var(--vscode-inputValidation-infoForeground);
      }

      .source-performance {
        color: var(--vscode-charts-yellow);
      }

      .source-ddl {
        color: var(--vscode-charts-orange);
      }

      .source-procedure {
        color: var(--vscode-charts-orange);
      }

      .source-risk {
        color: var(--vscode-inputValidation-warningForeground);
      }

      .source-governance {
        color: var(--vscode-charts-green);
      }

      .source-explainability {
        color: var(--vscode-charts-purple);
      }

      .empty {
        padding: 16px;
        border-radius: 10px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .empty.hidden {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>Logs</h1>
        <p class="subtitle">Live agent and orchestrator output.</p>
      </header>
      <div class="filters" id="filters">
        <button class="filter active" data-filter="all">All</button>
        <button class="filter" data-filter="orchestrator">Orchestrator</button>
        <button class="filter" data-filter="schema_analyst">Schema Analyst</button>
        <button class="filter" data-filter="performance">Performance</button>
        <button class="filter" data-filter="ddl">DDL</button>
        <button class="filter" data-filter="procedure">Procedure</button>
        <button class="filter" data-filter="risk">Risk</button>
        <button class="filter" data-filter="governance">Governance</button>
        <button class="filter" data-filter="explainability">Explainability</button>
      </div>
      <div id="empty" class="empty hidden">Log stream will appear here.</div>
      <div id="logList" class="log-list"></div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const filters = Array.from(document.querySelectorAll(".filter"));
      const logList = document.getElementById("logList");
      const empty = document.getElementById("empty");

      let activeFilter = "all";
      let entries = [];

      function formatSource(source) {
        if (!source) {
          return "";
        }
        if (source === "ddl") {
          return "DDL";
        }
        if (source === "schema_analyst") {
          return "Schema Analyst";
        }
        return source
          .split("_")
          .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
          .join(" ");
      }

      function setActiveFilter(filter) {
        activeFilter = filter;
        filters.forEach((button) => {
          button.classList.toggle("active", button.dataset.filter === filter);
        });
        render();
      }

      function render() {
        const filtered =
          activeFilter === "all"
            ? entries
            : entries.filter((entry) => entry.source === activeFilter);

        logList.innerHTML = "";
        if (!filtered.length) {
          empty.classList.remove("hidden");
          return;
        }
        empty.classList.add("hidden");

        const fragment = document.createDocumentFragment();
        filtered.forEach((entry) => {
          const row = document.createElement("div");
          row.className = "log-row";

          const time = document.createElement("span");
          time.className = "log-time";
          time.textContent = "[" + (entry.timestamp || "") + "]";

          const source = document.createElement("span");
          source.className =
            "log-source source-" + (entry.source ? entry.source : "orchestrator");
          source.textContent = formatSource(entry.source);

          const message = document.createElement("span");
          message.textContent = entry.message || "";

          row.appendChild(time);
          row.appendChild(source);
          row.appendChild(message);
          fragment.appendChild(row);
        });
        logList.appendChild(fragment);
        logList.scrollTop = logList.scrollHeight;
      }

      filters.forEach((button) => {
        button.addEventListener("click", () => {
          const filter = button.dataset.filter;
          if (!filter) {
            return;
          }
          setActiveFilter(filter);
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        entries = Array.isArray(message.entries) ? message.entries : [];
        render();
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
