import * as vscode from "vscode";

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private static currentProvider: AgentViewProvider | undefined;

  private view?: vscode.WebviewView;
  private selectedTab: { label: string; uri: string } | null = null;
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
    this.movedToSecondary = false;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as { type?: string } | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "pickTab") {
      await this.pickTab();
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
        gap: 12px;
        height: 100%;
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
        border: 1px solid var(--vscode-panel-border);
        padding: 14px;
        background: var(--vscode-editorWidget-background);
      }

      .card h2 {
        margin: 0 0 6px 0;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-sideBarTitle-foreground);
      }

      .muted {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.4;
      }

      .chat-card {
        border-radius: 14px;
        border: 1px solid var(--vscode-panel-border);
        padding: 10px 12px;
        background: color-mix(
          in srgb,
          var(--vscode-editorWidget-background) 92%,
          var(--vscode-editor-background)
        );
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: inset 0 1px 0
          color-mix(in srgb, var(--vscode-editor-foreground) 6%, transparent);
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
        border: 1px solid var(--vscode-panel-border);
        padding: 6px 8px;
        background: color-mix(
          in srgb,
          var(--vscode-input-background) 70%,
          transparent
        );
      }

      .chat-input textarea {
        flex: 1;
        min-height: 28px;
        max-height: 72px;
        resize: none;
        border: none;
        padding: 2px 0;
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
      }

      .chat-tool,
      .chat-tool-button {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 1px solid var(--vscode-panel-border);
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
      <div class="spacer"></div>
      <div class="chat-card">
        <div class="chat-input">
          <textarea placeholder="Ask a follow-up question"></textarea>
        </div>
        <div class="chat-toolbar">
          <div class="chat-tools" aria-hidden="true">
            <button class="chat-tool-button" id="tabPicker" type="button" aria-label="Select tab">
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
          <button class="chat-send" type="button" aria-label="Ask">
            <span class="sr-only">Ask</span>
            <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
              <path d="M4 12l8-4-8-4v8z" />
            </svg>
          </button>
        </div>
        <div id="chatContext" class="chat-context"></div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const tabPicker = document.getElementById("tabPicker");
      const chatContext = document.getElementById("chatContext");
      const textarea = document.querySelector(".chat-input textarea");

      function setContext(tab) {
        if (!chatContext) {
          return;
        }
        if (!tab) {
          chatContext.textContent = "";
          if (textarea) {
            textarea.placeholder = "Ask a follow-up question";
          }
          return;
        }
        chatContext.textContent = "Context: " + tab.label;
        if (textarea) {
          textarea.placeholder = "Ask about " + tab.label;
        }
      }

      tabPicker?.addEventListener("click", () => {
        vscode.postMessage({ type: "pickTab" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "tabSelected") {
          return;
        }
        setContext(message.tab);
      });
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
