import * as vscode from "vscode";

const CODELENS_ENABLED_SETTING = "codelens.enabled";

export class AnalyzeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly configDisposable: vscode.Disposable;
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor() {
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`sqlcortex.${CODELENS_ENABLED_SETTING}`)) {
        this.onDidChangeEmitter.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration("sqlcortex");
    const enabled = config.get<boolean>(CODELENS_ENABLED_SETTING, true);
    if (!enabled) {
      return [];
    }

    const line = firstContentLine(document);
    if (line === null) {
      return [];
    }

    const range = new vscode.Range(line, 0, line, 0);
    return [
      new vscode.CodeLens(range, {
        title: "SQLCortex: Analyze",
        command: "sqlcortex.analyzeDocument",
      }),
      new vscode.CodeLens(range, {
        title: "SQLCortex: Analyze (EXPLAIN ANALYZE)",
        command: "sqlcortex.analyzeDocumentWithAnalyze",
      }),
    ];
  }

  dispose(): void {
    this.configDisposable.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

function firstContentLine(document: vscode.TextDocument): number | null {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text.trim().length > 0) {
      return line;
    }
  }
  return null;
}
