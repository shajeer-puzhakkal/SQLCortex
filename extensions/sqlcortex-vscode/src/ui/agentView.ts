import * as vscode from "vscode";

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private static currentProvider: AgentViewProvider | undefined;

  private view?: vscode.WebviewView;
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
      enableScripts: false,
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => this.dispose(), null, this.disposables);
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
    const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`].join(
      "; "
    );

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
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="header">
        <h1>SQLCortex Agent</h1>
        <p class="subtitle">Coordinate multi-step database work here.</p>
      </header>
      <section class="card">
        <h2>Agent</h2>
        <p class="muted">Coming soon: guided workflows, chained queries, and richer automation.</p>
      </section>
    </div>
  </body>
</html>`;
  }
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
