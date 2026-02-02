import * as vscode from "vscode";
import type { SchemaInsightsStats } from "../api/types";

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type AgentChatContext =
  | {
      type: "schema";
      projectId: string;
      schemaName: string;
      tableName?: string | null;
      stats: SchemaInsightsStats;
      findings: string[];
      suggestions: string[];
    }
  | {
      type: "query";
      projectId: string;
      connectionId: string;
      sql: string;
      explainJson: unknown;
    };

export type AgentChatHandler = (input: {
  text: string;
  context: AgentChatContext;
  history: AgentChatMessage[];
}) => Promise<{ answer: string }>;

type AgentInsightsGate = {
  title: string;
  description: string;
  ctaLabel: string;
  upgradeUrl: string | null;
};

type InsightsMode = "EXPLAIN" | "EXPLAIN_ANALYZE" | "SCHEMA" | "TABLE";

export type AgentInsightsState =
  | { kind: "idle" }
  | { kind: "loading"; data: { hash: string; mode: InsightsMode } }
  | {
      kind: "success";
      data: {
        hash: string;
        mode: InsightsMode;
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
        mode: InsightsMode;
        findings: string[];
        suggestions: string[];
        warnings: string[];
        assumptions: string[];
        explanation: string | null;
        eventId: string | null;
        gate: AgentInsightsGate;
      };
    }
  | {
      kind: "error";
      error: { message: string };
      data?: { hash?: string; mode?: InsightsMode };
    };

type AgentChatState = {
  messages: AgentChatMessage[];
  pending: boolean;
  disabledReason: string | null;
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "pickTab" }
  | { type: "askChat"; text: string }
  | { type: "openUpgrade"; url?: string | null };

const DEFAULT_CHAT_DISABLED = "";

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private static currentProvider: AgentViewProvider | undefined;

  private view?: vscode.WebviewView;
  private selectedTab: { label: string; uri: string } | null = null;
  private insightsState: AgentInsightsState = { kind: "idle" };
  private chatState: AgentChatState = {
    messages: [],
    pending: false,
    disabledReason: DEFAULT_CHAT_DISABLED,
  };
  private chatContext: AgentChatContext | null = null;
  private chatHandler: AgentChatHandler | null = null;
  private contextLabel: string | null = null;
  private isReady = false;
  private movedToSecondary = false;
  private readonly disposables: vscode.Disposable[] = [];

  static register(context: vscode.ExtensionContext): AgentViewProvider {
    const provider = new AgentViewProvider(context);
    AgentViewProvider.currentProvider = provider;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("sqlcortex.agentView", provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    return provider;
  }

  static show(context: vscode.ExtensionContext): AgentViewProvider {
    if (!AgentViewProvider.currentProvider) {
      AgentViewProvider.register(context);
    }
    AgentViewProvider.currentProvider?.reveal();
    return AgentViewProvider.currentProvider!;
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
    void this.ensureSecondarySideBar();
  }

  updateInsights(
    state: AgentInsightsState,
    options?: { contextLabel?: string | null }
  ): void {
    this.insightsState = state;
    if (options && "contextLabel" in options) {
      this.contextLabel = options.contextLabel ?? null;
      this.postChatState();
    }
    this.postInsightsState();
  }

  setChatHandler(handler: AgentChatHandler | null): void {
    this.chatHandler = handler;
  }

  setChatContext(
    context: AgentChatContext | null,
    options?: { contextLabel?: string | null; disabledReason?: string | null }
  ): void {
    const contextChanged = this.chatContext
      ? !context ||
        this.chatContext.type !== context.type ||
        (context.type === "schema" &&
          this.chatContext.type === "schema" &&
          (this.chatContext.schemaName !== context.schemaName ||
            this.chatContext.tableName !== context.tableName ||
            this.chatContext.projectId !== context.projectId)) ||
        (context.type === "query" &&
          this.chatContext.type === "query" &&
          (this.chatContext.projectId !== context.projectId ||
            this.chatContext.connectionId !== context.connectionId ||
            this.chatContext.sql !== context.sql))
      : context !== null;

    this.chatContext = context;
    this.chatState.pending = false;
    if (contextChanged) {
      this.chatState.messages = [];
    }

    if (options && "contextLabel" in options) {
      this.contextLabel = options.contextLabel ?? null;
    }

    if (options && "disabledReason" in options) {
      this.chatState.disabledReason = options.disabledReason ?? null;
    } else {
      this.chatState.disabledReason = context ? null : DEFAULT_CHAT_DISABLED;
    }
    this.postChatState();
  }

  resetChat(): void {
    this.chatState = {
      messages: [],
      pending: false,
      disabledReason: this.chatContext ? null : DEFAULT_CHAT_DISABLED,
    };
    this.postChatState();
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
    } else {
      await tryExecuteCommand("workbench.action.openView", "sqlcortex.agentView");
    }
    await this.ensureSecondarySideBar();
  }

  private dispose(): void {
    if (AgentViewProvider.currentProvider === this && this.view) {
      this.view = undefined;
    }
    this.isReady = false;
    this.movedToSecondary = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as WebviewMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "ready") {
      this.isReady = true;
      this.postInsightsState();
      this.postChatState();
      this.postSelectedTab();
      return;
    }
    if (payload.type === "pickTab") {
      await this.pickTab();
      return;
    }
    if (payload.type === "askChat") {
      await this.handleChatRequest(payload.text);
      return;
    }
    if (payload.type === "openUpgrade") {
      const url = payload.url ?? "";
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  }

  private async pickTab(): Promise<void> {
    const items = this.getOpenTabItems();
    if (items.length === 0) {
      void vscode.window.showInformationMessage("SQLCortex: No open tabs found.");
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select an open tab for Agent context",
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    this.selectedTab = { label: picked.label, uri: picked.uri };
    this.postSelectedTab();
  }

  private getOpenTabItems(): Array<{ label: string; description?: string; uri: string }> {
    const seen = new Set<string>();
    const items: Array<{ label: string; description?: string; uri: string }> = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as
          | vscode.TabInputText
          | vscode.TabInputTextDiff
          | vscode.TabInputNotebook
          | vscode.TabInputNotebookDiff
          | undefined;
        const uri =
          input && "uri" in input
            ? input.uri
            : input && "modified" in input
              ? input.modified
              : undefined;
        if (!uri) {
          continue;
        }
        if (uri.scheme !== "file" && uri.scheme !== "untitled") {
          continue;
        }
        const key = uri.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push({
          label: tab.label,
          description:
            uri.scheme === "untitled" ? "Untitled" : vscode.workspace.asRelativePath(uri),
          uri: uri.toString(),
        });
      }
    }

    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    if (
      activeUri &&
      (activeUri.scheme === "file" || activeUri.scheme === "untitled") &&
      !seen.has(activeUri.toString())
    ) {
      items.unshift({
        label: vscode.window.activeTextEditor?.document?.fileName ?? "Active Editor",
        description:
          activeUri.scheme === "untitled"
            ? "Untitled"
            : vscode.workspace.asRelativePath(activeUri),
        uri: activeUri.toString(),
      });
    }

    return items;
  }

  private postSelectedTab(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: "tabSelected",
      tab: this.selectedTab,
    });
  }

  private postInsightsState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({
      type: "insights",
      state: this.insightsState,
      contextLabel: this.contextLabel,
    });
  }

  private postChatState(): void {
    if (!this.view || !this.isReady) {
      return;
    }
    void this.view.webview.postMessage({
      type: "chat",
      chat: this.chatState,
      contextLabel: this.contextLabel,
    });
  }

  private async handleChatRequest(text: string): Promise<void> {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      return;
    }
    if (!this.chatContext) {
      this.chatState.messages.push(
        this.createChatMessage("assistant", DEFAULT_CHAT_DISABLED)
      );
      this.postChatState();
      return;
    }
    if (this.chatState.pending) {
      return;
    }

    this.chatState.messages.push(this.createChatMessage("user", trimmed));
    this.chatState.pending = true;
    this.postChatState();

    if (!this.chatHandler) {
      this.chatState.pending = false;
      this.chatState.messages.push(
        this.createChatMessage("assistant", "Chat is unavailable right now.")
      );
      this.postChatState();
      return;
    }

    try {
      const response = await this.chatHandler({
        text: trimmed,
        context: this.chatContext,
        history: this.chatState.messages,
      });
      const answer = response.answer?.trim() || "AI response is unavailable.";
      this.chatState.messages.push(this.createChatMessage("assistant", answer));
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : "Unable to fetch a response.";
      this.chatState.messages.push(this.createChatMessage("assistant", message));
    } finally {
      this.chatState.pending = false;
      this.postChatState();
    }
  }

  private createChatMessage(role: "user" | "assistant", text: string): AgentChatMessage {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      role,
      text,
      timestamp: new Date().toISOString(),
    };
  }

  private async ensureSecondarySideBar(): Promise<void> {
    if (this.movedToSecondary || !this.view) {
      return;
    }
    this.movedToSecondary = true;
    this.view.show(true);
    await tryExecuteCommand("workbench.action.moveViewToSecondarySideBar", "sqlcortex.agentView");
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
    <title>SQLCortex Agent</title>
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
        gap: 16px;
        min-height: 100%;
      }

      .chat-shell-root {
        margin-top: auto;
        border: none;
        background: transparent;
        padding: 0;
        box-shadow: none;
      }

      .header {
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

      .card {
        border-radius: 12px;
        border: none;
        padding: 14px;
        background: var(--vscode-editorWidget-background);
      }

      .card.chat-shell-root {
        padding: 0;
        background: transparent;
      }

      .card h2 {
        margin: 0 0 6px 0;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-sideBarTitle-foreground);
      }

      .section-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .section-header h2 {
        margin: 0;
      }

      .pill-row {
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
        background: var(--vscode-editor-background);
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

      .hidden {
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

      .sections {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 12px;
      }

      .section {
        border-radius: 10px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        padding: 12px;
      }

      .section h3 {
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
        margin-top: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .mono {
        font-family: var(--vscode-editor-font-family);
      }

      .chat-shell {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .chat-thread {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 220px;
        overflow-y: auto;
        padding-right: 2px;
      }

      .chat-message {
        padding: 8px 10px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.5;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .chat-message.user {
        align-self: flex-end;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: transparent;
      }

      .chat-placeholder {
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        padding: 10px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
      }

      .chat-pending {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .muted {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.4;
      }

      .chat-card {
        border-radius: 14px;
        border: none;
        padding: 0;
        background: transparent;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-shadow: none;
      }

      .chat-card-title {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .chat-input {
        display: flex;
        gap: 8px;
        align-items: center;
        border-radius: 10px;
        border: none;
        padding: 10px 12px;
        background: color-mix(
          in srgb,
          var(--vscode-input-background) 70%,
          transparent
        );
        width: 100%;
        max-width: 100%;
        margin: 0;
        box-sizing: border-box;
      }

      .chat-input textarea {
        flex: 1;
        min-height: 40px;
        max-height: 96px;
        resize: none;
        border: none;
        padding: 2px 6px;
        background: transparent;
        color: var(--vscode-input-foreground);
        font-family: var(--vscode-font-family);
        font-size: 12px;
        outline: none;
      }

      .chat-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .chat-context {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .chat-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--vscode-descriptionForeground);
        flex-wrap: wrap;
      }

      .chat-tool,
      .chat-tool-button {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: none;
        background: color-mix(
          in srgb,
          var(--vscode-editorWidget-background) 88%,
          transparent
        );
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .chat-tool svg,
      .chat-tool-button svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        stroke-width: 1.5;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .chat-tool-button {
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        padding: 0;
      }

      .chat-tool-button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }

      .chat-send {
        border: none;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        padding: 0;
        cursor: pointer;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .chat-send svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .chat-send:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .chat-hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin: 0;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        border: 0;
      }

      .spacer {
        flex: 1;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="header">
        <h1>SQLCortex Agent</h1>
        <p class="subtitle">Coordinate multi-step database work here.</p>
      </header>
      <section id="insightsShell" class="card hidden">
        <div class="section-header">
          <div>
            <h2>Insights</h2>
            <p class="subtitle" id="subtitle">Analyze a schema or table to see results here.</p>
          </div>
          <div class="pill-row">
            <span id="hash" class="pill">-</span>
            <span id="mode" class="pill">-</span>
          </div>
        </div>
        <div id="status" class="status">Waiting for analysis...</div>
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
            <h3>Findings (Rules)</h3>
            <div id="findings"></div>
          </section>
          <section class="section">
            <h3>AI Explanation</h3>
            <div id="ai"></div>
          </section>
          <section class="section">
            <h3>Suggestions</h3>
            <div id="suggestions"></div>
          </section>
          <section class="section">
            <h3>Warnings</h3>
            <div id="warnings"></div>
          </section>
          <section class="section">
            <h3>Assumptions</h3>
            <div id="assumptions"></div>
          </section>
        </div>
        <div class="footer">
          <span>Event ID: </span><span id="eventId" class="mono">-</span>
        </div>
      </section>

      <section class="card chat-shell-root">
        <div class="section-header">
          <div id="chatContext" class="chat-context"></div>
        </div>
        <div class="chat-shell">
          <div id="chatMessages" class="chat-thread"></div>
          <div id="chatPending" class="chat-pending"></div>
          <div class="chat-card">
            <div class="chat-input">
              <textarea id="chatInput" placeholder="Agent Chat"></textarea>
            </div>
            <div class="chat-toolbar">
              <div class="chat-tools" aria-hidden="true">
                <button
                  class="chat-tool-button"
                  id="tabPicker"
                  type="button"
                  aria-label="Select tab"
                >
                  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </button>
                <span class="chat-tool">
                  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                    <path d="M3 4h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7l-3 2v-2H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                  </svg>
                </span>
                <span class="chat-tool">
                  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                    <path d="M3 5l5-3 5 3v6l-5 3-5-3z" />
                    <path d="M8 2v12" />
                  </svg>
                </span>
                <span class="chat-tool">
                  <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                    <path d="M6 4H3v3" />
                    <path d="M3 7a5 5 0 1 0 1.5-3.5" />
                  </svg>
                </span>
              </div>
              <button id="chatSend" class="chat-send" type="button" aria-label="Ask">
                <span class="sr-only">Ask</span>
                <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                  <path d="M4 12l8-4-8-4v8z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const insightsShell = document.getElementById("insightsShell");
      const subtitle = document.getElementById("subtitle");
      const hashEl = document.getElementById("hash");
      const modeEl = document.getElementById("mode");
      const statusEl = document.getElementById("status");
      const gateEl = document.getElementById("gate");
      const gateTitleEl = document.getElementById("gateTitle");
      const gateDescriptionEl = document.getElementById("gateDescription");
      const gateButtonEl = document.getElementById("gateButton");
      const findingsEl = document.getElementById("findings");
      const aiEl = document.getElementById("ai");
      const suggestionsEl = document.getElementById("suggestions");
      const warningsEl = document.getElementById("warnings");
      const assumptionsEl = document.getElementById("assumptions");
      const eventIdEl = document.getElementById("eventId");
      const chatContext = document.getElementById("chatContext");
      const chatMessagesEl = document.getElementById("chatMessages");
      const chatPendingEl = document.getElementById("chatPending");
      const chatInput = document.getElementById("chatInput");
      const chatSend = document.getElementById("chatSend");
      const tabPicker = document.getElementById("tabPicker");

      let upgradeUrl = "";
      let selectedTabLabel = "";
      let insightsContextLabel = "";

      function updateContextLabel() {
        const label = insightsContextLabel || selectedTabLabel;
        if (chatContext) {
          chatContext.textContent = label ? "Context: " + label : "";
        }
        if (chatInput) {
          chatInput.placeholder = label ? "Ask about " + label : "Agent Chat";
        }
      }

      function setContextLabel(label) {
        insightsContextLabel = label || "";
        updateContextLabel();
      }

      function setSelectedTab(tab) {
        selectedTabLabel = tab && tab.label ? tab.label : "";
        updateContextLabel();
      }

      function formatMode(value) {
        if (value === "SCHEMA") {
          return "SCHEMA";
        }
        if (value === "TABLE") {
          return "TABLE";
        }
        return value === "EXPLAIN_ANALYZE" ? "EXPLAIN ANALYZE" : "EXPLAIN";
      }

      function setMeta(hash, mode) {
        if (hash) {
          const shouldShorten = mode !== "SCHEMA" && mode !== "TABLE";
          const shortHash = shouldShorten && hash.length > 10 ? hash.slice(0, 10) : hash;
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
        gateTitleEl.textContent =
          gate.title || "You have reached today's AI limit. Upgrade to Pro for uninterrupted usage.";
        gateDescriptionEl.textContent = gate.description || "";
        gateButtonEl.textContent = gate.ctaLabel || "Open dashboard to upgrade";
        upgradeUrl = gate.upgradeUrl || "";
        gateButtonEl.disabled = !upgradeUrl;
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
          if (insightsShell) {
            insightsShell.classList.add("hidden");
          }
          subtitle.textContent = "Analyze a schema or table to see results here.";
          setMeta(null, null);
          setStatus("Waiting for analysis...", false);
          setGate(null);
          renderList(findingsEl, [], "No findings yet.");
          renderList(aiEl, [], "No AI explanation yet.");
          renderList(suggestionsEl, [], "No suggestions yet.");
          renderList(warningsEl, [], "No warnings.");
          renderList(assumptionsEl, [], "No assumptions.");
          eventIdEl.textContent = "-";
          return;
        }

        if (state.kind === "loading") {
          if (insightsShell) {
            insightsShell.classList.remove("hidden");
          }
          subtitle.textContent = "Analyzing...";
          setMeta(state.data.hash, state.data.mode);
          setStatus("Analyzing insights...", false);
          setGate(null);
          renderList(findingsEl, [], "Analyzing...");
          renderList(aiEl, [], "Analyzing...");
          renderList(suggestionsEl, [], "Analyzing...");
          renderList(warningsEl, [], "Analyzing...");
          renderList(assumptionsEl, [], "Analyzing...");
          eventIdEl.textContent = "-";
          return;
        }

        if (state.kind === "error") {
          if (insightsShell) {
            insightsShell.classList.remove("hidden");
          }
          subtitle.textContent = "Analysis failed.";
          setMeta(state.data?.hash || null, state.data?.mode || null);
          setStatus(state.error.message || "Analysis failed.", true);
          setGate(null);
          renderList(findingsEl, [], "No findings.");
          renderList(aiEl, [], "No AI explanation.");
          renderList(suggestionsEl, [], "No suggestions.");
          renderList(warningsEl, [], "No warnings.");
          renderList(assumptionsEl, [], "No assumptions.");
          eventIdEl.textContent = "-";
          return;
        }

        const gated = state.kind === "gated";
        if (insightsShell) {
          insightsShell.classList.remove("hidden");
        }
        subtitle.textContent = gated ? state.data.gate.title : "Analysis complete.";
        setMeta(state.data.hash, state.data.mode);
        setStatus(gated ? state.data.gate.title : "Analysis complete.", false);
        setGate(gated ? state.data.gate : null);
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

      let chatState = { messages: [], pending: false, disabledReason: null };

      function renderChat(chat) {
        if (!chatMessagesEl) {
          return;
        }
        chatState = chat || { messages: [], pending: false, disabledReason: null };
        chatMessagesEl.innerHTML = "";
        if (!chatState.messages || !chatState.messages.length) {
          const placeholderText = chatState.disabledReason
            ? chatState.disabledReason
            : "";
          if (placeholderText) {
            const placeholder = document.createElement("div");
            placeholder.className = "chat-placeholder";
            placeholder.textContent = placeholderText;
            chatMessagesEl.appendChild(placeholder);
          }
        } else {
          chatState.messages.forEach((message) => {
            const bubble = document.createElement("div");
            bubble.className = "chat-message " + message.role;
            bubble.textContent = message.text;
            chatMessagesEl.appendChild(bubble);
          });
          chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        }

        if (chatPendingEl) {
          chatPendingEl.textContent = chatState.pending ? "SQLCortex is thinking..." : "";
        }

        const disabled = Boolean(chatState.disabledReason);
        updateContextLabel();
        if (chatInput) {
          chatInput.disabled = disabled || chatState.pending;
          if (disabled && chatState.disabledReason) {
            chatInput.placeholder = chatState.disabledReason;
          }
        }
        if (chatSend) {
          chatSend.disabled = disabled || chatState.pending;
        }
      }

      function sendChat() {
        if (!chatInput || !chatSend) {
          return;
        }
        if (chatSend.disabled) {
          return;
        }
        const text = chatInput.value.trim();
        if (!text) {
          return;
        }
        vscode.postMessage({ type: "askChat", text });
        chatInput.value = "";
      }

      if (gateButtonEl) {
        gateButtonEl.addEventListener("click", () => {
          if (!upgradeUrl) {
            return;
          }
          vscode.postMessage({ type: "openUpgrade", url: upgradeUrl });
        });
      }

      if (chatSend) {
        chatSend.addEventListener("click", sendChat);
      }
      if (chatInput) {
        chatInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendChat();
          }
        });
      }

      tabPicker?.addEventListener("click", () => {
        vscode.postMessage({ type: "pickTab" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || !message.type) {
          return;
        }
        if (message.type === "insights") {
          render(message.state);
          if ("contextLabel" in message) {
            setContextLabel(message.contextLabel || "");
          }
        }
        if (message.type === "chat") {
          renderChat(message.chat);
          if ("contextLabel" in message) {
            setContextLabel(message.contextLabel || "");
          }
        }
        if (message.type === "tabSelected") {
          setSelectedTab(message.tab);
        }
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
