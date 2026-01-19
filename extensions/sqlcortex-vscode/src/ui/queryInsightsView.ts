import * as vscode from "vscode";
import type { ExplainMode } from "../api/types";

type QueryInsightsGate = {
  title: string;
  description: string;
  ctaLabel: string;
  upgradeUrl: string | null;
};

export type QueryInsightsState =
  | { kind: "idle" }
  | { kind: "loading"; data: { hash: string; mode: ExplainMode } }
  | {
      kind: "confirm";
      data: {
        hash: string;
        mode: ExplainMode;
        estimatedCredits: number;
        remainingCredits: number;
        dailyCredits: number;
        notice?: string | null;
      };
    }
  | {
      kind: "success";
      data: {
        hash: string;
        mode: ExplainMode;
        findings: string[];
        suggestions: string[];
        warnings: string[];
        assumptions: string[];
        explanation: string | null;
        eventId: string | null;
      };
    }
  | {
      kind: "gated";
      data: {
        hash: string;
        mode: ExplainMode;
        findings: string[];
        suggestions: string[];
        warnings: string[];
        assumptions: string[];
        explanation: string | null;
        eventId: string | null;
        gate: QueryInsightsGate;
      };
    }
  | {
      kind: "error";
      error: { message: string };
      data?: { hash?: string; mode?: ExplainMode };
    };

type WebviewMessage =
  | { type: "ready" }
  | { type: "openUpgrade"; url?: string | null }
  | { type: "confirmRun" }
  | { type: "cancelRun" };

export class QueryInsightsView implements vscode.WebviewViewProvider {
  private static currentProvider: QueryInsightsView | undefined;
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private isReady = false;
  private lastState: QueryInsightsState = { kind: "idle" };
  private movedToSecondary = false;
  private pendingConfirmation: ((value: boolean) => void) | null = null;

  static register(context: vscode.ExtensionContext): QueryInsightsView {
    const provider = new QueryInsightsView(context);
    QueryInsightsView.currentProvider = provider;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("sqlcortex.queryInsights", provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    return provider;
  }

  static show(context: vscode.ExtensionContext): QueryInsightsView {
    if (!QueryInsightsView.currentProvider) {
      QueryInsightsView.register(context);
    }
    QueryInsightsView.currentProvider?.reveal();
    return QueryInsightsView.currentProvider!;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => this.dispose(), null, this.disposables);
    view.webview.onDidReceiveMessage(
      (message) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables
    );

    this.postState();
    void this.ensureSecondarySideBar();
  }

  update(state: QueryInsightsState): void {
    this.lastState = state;
    this.postState();
  }

  async requestConfirmation(
    data: Extract<QueryInsightsState, { kind: "confirm" }>["data"]
  ): Promise<boolean> {
    if (this.pendingConfirmation) {
      this.pendingConfirmation(false);
    }
    this.update({ kind: "confirm", data });
    return new Promise((resolve) => {
      this.pendingConfirmation = resolve;
    });
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
    } else {
      await tryExecuteCommand("workbench.action.openView", "sqlcortex.queryInsights");
    }
    await this.ensureSecondarySideBar();
  }

  private postState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", state: this.lastState });
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

    if (payload.type === "openUpgrade") {
      const url = typeof payload.url === "string" ? payload.url : "";
      if (!url) {
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    if (payload.type === "confirmRun") {
      if (this.pendingConfirmation) {
        this.pendingConfirmation(true);
        this.pendingConfirmation = null;
      }
      return;
    }

    if (payload.type === "cancelRun") {
      if (this.pendingConfirmation) {
        this.pendingConfirmation(false);
        this.pendingConfirmation = null;
      }
    }
  }

  private dispose(): void {
    if (QueryInsightsView.currentProvider === this && this.view) {
      this.view = undefined;
    }
    this.isReady = false;
    this.movedToSecondary = false;
    if (this.pendingConfirmation) {
      this.pendingConfirmation(false);
      this.pendingConfirmation = null;
    }
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async ensureSecondarySideBar(): Promise<void> {
    if (this.movedToSecondary || !this.view) {
      return;
    }
    this.movedToSecondary = true;
    this.view.show(true);
    await tryExecuteCommand("workbench.action.moveViewToSecondarySideBar", "sqlcortex.queryInsights");
    await tryExecuteCommand("workbench.action.moveViewToSecondarySideBar");
    await openAuxiliaryBar();
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
    <title>SQLCortex Query Insights</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      body {
        margin: 0;
        padding: 20px 18px 24px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-sideBar-foreground);
        background: var(--vscode-sideBar-background);
      }

      .shell {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .header {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .header-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        letter-spacing: 0.02em;
      }

      .meta {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .pill {
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--vscode-panel-border);
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .status {
        padding: 10px 12px;
        border-radius: 8px;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border);
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .status.error {
        border-color: var(--vscode-inputValidation-errorBorder);
        color: var(--vscode-inputValidation-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
      }

      .gate {
        display: flex;
        flex-direction: column;
        gap: 10px;
        border-radius: 8px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
      }

      .gate.hidden {
        display: none;
      }

      .gate-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }

      .gate-description {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .gate-button {
        align-self: flex-start;
        border-radius: 6px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }

      .gate-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .confirm {
        display: flex;
        flex-direction: column;
        gap: 10px;
        border-radius: 8px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
      }

      .confirm.hidden {
        display: none;
      }

      .confirm-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }

      .confirm-description {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .confirm-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .confirm-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        border-radius: 6px;
        border: 1px solid var(--vscode-panel-border);
        padding: 8px;
        background: var(--vscode-editor-background);
      }

      .confirm-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-descriptionForeground);
      }

      .confirm-value {
        font-size: 14px;
        font-weight: 600;
      }

      .confirm-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .confirm-button {
        border-radius: 6px;
        border: 1px solid var(--vscode-button-border, transparent);
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
      }

      .confirm-button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .confirm-button.secondary {
        background: transparent;
        color: var(--vscode-descriptionForeground);
      }

      .sections {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .section {
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
      }

      .section h2 {
        margin: 0 0 8px 0;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-sideBarTitle-foreground);
      }

      ul {
        margin: 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
        line-height: 1.5;
      }

      .empty {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .footer {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .mono {
        font-family: var(--vscode-editor-font-family);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="header">
        <div class="header-top">
          <div>
            <h1>Query Insights</h1>
            <p class="subtitle" id="subtitle">Analyze a SQL selection to see results here.</p>
          </div>
          <div class="meta">
            <span id="hash" class="pill">-</span>
            <span id="mode" class="pill">-</span>
          </div>
        </div>
      </header>

      <div id="status" class="status">Waiting for analysis...</div>
      <div id="confirm" class="confirm hidden">
        <div>
          <p class="confirm-title">Confirm AI credit usage</p>
          <p id="confirmDescription" class="confirm-description"></p>
        </div>
        <div class="confirm-grid">
          <div class="confirm-row">
            <span class="confirm-label">Estimated cost</span>
            <span id="confirmEstimated" class="confirm-value"></span>
          </div>
          <div class="confirm-row">
            <span class="confirm-label">Remaining after run</span>
            <span id="confirmRemaining" class="confirm-value"></span>
          </div>
        </div>
        <div class="confirm-actions">
          <button id="confirmRun" class="confirm-button primary" type="button">Run</button>
          <button id="confirmCancel" class="confirm-button secondary" type="button">Cancel</button>
        </div>
      </div>
      <div id="gate" class="gate hidden">
        <div>
          <p id="gateTitle" class="gate-title"></p>
          <p id="gateDescription" class="gate-description"></p>
        </div>
        <button id="gateButton" class="gate-button" type="button">
          Open dashboard to upgrade
        </button>
      </div>

      <div class="sections">
        <section class="section">
          <h2>Findings (Rules)</h2>
          <div id="findings"></div>
        </section>
        <section class="section">
          <h2>AI Explanation</h2>
          <div id="ai"></div>
        </section>
        <section class="section">
          <h2>Suggestions</h2>
          <div id="suggestions"></div>
        </section>
        <section class="section">
          <h2>Warnings</h2>
          <div id="warnings"></div>
        </section>
        <section class="section">
          <h2>Assumptions</h2>
          <div id="assumptions"></div>
        </section>
      </div>

      <div class="footer">
        <span>Event ID: </span><span id="eventId" class="mono">-</span>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const subtitle = document.getElementById("subtitle");
      const hashEl = document.getElementById("hash");
      const modeEl = document.getElementById("mode");
      const statusEl = document.getElementById("status");
      const gateEl = document.getElementById("gate");
      const gateTitleEl = document.getElementById("gateTitle");
      const gateDescriptionEl = document.getElementById("gateDescription");
      const gateButtonEl = document.getElementById("gateButton");
      const confirmEl = document.getElementById("confirm");
      const confirmDescriptionEl = document.getElementById("confirmDescription");
      const confirmEstimatedEl = document.getElementById("confirmEstimated");
      const confirmRemainingEl = document.getElementById("confirmRemaining");
      const confirmRunEl = document.getElementById("confirmRun");
      const confirmCancelEl = document.getElementById("confirmCancel");
      const findingsEl = document.getElementById("findings");
      const aiEl = document.getElementById("ai");
      const suggestionsEl = document.getElementById("suggestions");
      const warningsEl = document.getElementById("warnings");
      const assumptionsEl = document.getElementById("assumptions");
      const eventIdEl = document.getElementById("eventId");
      let upgradeUrl = "";

      function formatMode(value) {
        return value === "EXPLAIN_ANALYZE" ? "EXPLAIN ANALYZE" : "EXPLAIN";
      }

      function setMeta(hash, mode) {
        if (hash) {
          const shortHash = hash.length > 8 ? hash.slice(0, 8) : hash;
          hashEl.textContent = shortHash;
          hashEl.title = hash;
        } else {
          hashEl.textContent = "-";
          hashEl.title = "";
        }
        modeEl.textContent = mode ? formatMode(mode) : "-";
      }

      function setStatus(text, isError) {
        statusEl.textContent = text;
        statusEl.classList.toggle("error", Boolean(isError));
      }

      function setGate(gate) {
        if (!gate || !gateEl || !gateTitleEl || !gateDescriptionEl || !gateButtonEl) {
          if (gateEl) {
            gateEl.classList.add("hidden");
          }
          upgradeUrl = "";
          return;
        }
        gateEl.classList.remove("hidden");
        gateTitleEl.textContent = gate.title || "AI is gated.";
        gateDescriptionEl.textContent = gate.description || "";
        gateButtonEl.textContent = gate.ctaLabel || "Open dashboard to upgrade";
        upgradeUrl = gate.upgradeUrl || "";
        gateButtonEl.disabled = !upgradeUrl;
      }

      function setConfirm(confirm) {
        if (
          !confirm ||
          !confirmEl ||
          !confirmDescriptionEl ||
          !confirmEstimatedEl ||
          !confirmRemainingEl
        ) {
          if (confirmEl) {
            confirmEl.classList.add("hidden");
          }
          return;
        }
        confirmEl.classList.remove("hidden");
        const baseCopy = "Daily credits: " + confirm.dailyCredits + ".";
        confirmDescriptionEl.textContent = confirm.notice
          ? confirm.notice + " " + baseCopy
          : baseCopy;
        confirmEstimatedEl.textContent = confirm.estimatedCredits + " credits";
        confirmRemainingEl.textContent = confirm.remainingCredits + " credits";
      }

      if (gateButtonEl) {
        gateButtonEl.addEventListener("click", () => {
          if (!upgradeUrl) {
            return;
          }
          vscode.postMessage({ type: "openUpgrade", url: upgradeUrl });
        });
      }

      if (confirmRunEl) {
        confirmRunEl.addEventListener("click", () => {
          vscode.postMessage({ type: "confirmRun" });
        });
      }

      if (confirmCancelEl) {
        confirmCancelEl.addEventListener("click", () => {
          vscode.postMessage({ type: "cancelRun" });
        });
      }

      function renderList(container, items, emptyText) {
        container.innerHTML = "";
        if (!items || !items.length) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = emptyText;
          container.appendChild(empty);
          return;
        }
        const list = document.createElement("ul");
        items.forEach((item) => {
          const li = document.createElement("li");
          li.textContent = item;
          list.appendChild(li);
        });
        container.appendChild(list);
      }

      function render(state) {
        if (!state || state.kind === "idle") {
          subtitle.textContent = "Analyze a SQL selection to see results here.";
          setMeta(null, null);
          setStatus("Waiting for analysis...", false);
          setGate(null);
          setConfirm(null);
          renderList(findingsEl, [], "No findings yet.");
          renderList(aiEl, [], "No AI explanation yet.");
          renderList(suggestionsEl, [], "No suggestions yet.");
          renderList(warningsEl, [], "No warnings.");
          renderList(assumptionsEl, [], "No assumptions.");
          eventIdEl.textContent = "-";
          return;
        }

        if (state.kind === "loading") {
          subtitle.textContent = "Analyzing selection...";
          setMeta(state.data.hash, state.data.mode);
          setStatus("Analyzing query insights...", false);
          setGate(null);
          setConfirm(null);
          renderList(findingsEl, [], "Analyzing...");
          renderList(aiEl, [], "Analyzing...");
          renderList(suggestionsEl, [], "Analyzing...");
          renderList(warningsEl, [], "Analyzing...");
          renderList(assumptionsEl, [], "Analyzing...");
          eventIdEl.textContent = "-";
          return;
        }

        if (state.kind === "confirm") {
          subtitle.textContent = "Confirm AI credits before running.";
          setMeta(state.data.hash, state.data.mode);
          setStatus("Awaiting confirmation...", false);
          setGate(null);
          setConfirm(state.data);
          renderList(findingsEl, [], "Awaiting confirmation.");
          renderList(aiEl, [], "Awaiting confirmation.");
          renderList(suggestionsEl, [], "Awaiting confirmation.");
          renderList(warningsEl, [], "Awaiting confirmation.");
          renderList(assumptionsEl, [], "Awaiting confirmation.");
          eventIdEl.textContent = "-";
          return;
        }

        if (state.kind === "error") {
          subtitle.textContent = "Analysis failed.";
          setMeta(state.data?.hash || null, state.data?.mode || null);
          setStatus(state.error.message || "Analysis failed.", true);
          setGate(null);
          setConfirm(null);
          renderList(findingsEl, [], "No findings.");
          renderList(aiEl, [], "No AI explanation.");
          renderList(suggestionsEl, [], "No suggestions.");
          renderList(warningsEl, [], "No warnings.");
          renderList(assumptionsEl, [], "No assumptions.");
          eventIdEl.textContent = "-";
          return;
        }

        const gated = state.kind === "gated";
        subtitle.textContent = gated ? "Analysis complete (AI gated)." : "Analysis complete.";
        setMeta(state.data.hash, state.data.mode);
        setStatus(gated ? state.data.gate.title : "Analysis complete.", false);
        setGate(gated ? state.data.gate : null);
        setConfirm(null);
        renderList(findingsEl, state.data.findings, "No findings.");
        renderList(
          aiEl,
          state.data.explanation ? [state.data.explanation] : [],
          "No AI explanation."
        );
        renderList(suggestionsEl, state.data.suggestions, "No suggestions.");
        renderList(warningsEl, state.data.warnings, "No warnings.");
        renderList(assumptionsEl, state.data.assumptions, "No assumptions.");
        eventIdEl.textContent = state.data.eventId || "-";
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

function getNonce(): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}

async function tryExecuteCommand(command: string, ...args: unknown[]): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch {
    return false;
  }
}

async function openAuxiliaryBar(): Promise<void> {
  const attempts = ["workbench.action.openAuxiliaryBar", "workbench.action.focusAuxiliaryBar"];
  for (const command of attempts) {
    const handled = await tryExecuteCommand(command);
    if (handled) {
      return;
    }
  }
}
