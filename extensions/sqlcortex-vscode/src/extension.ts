import * as vscode from "vscode";

const COMMANDS: Array<{ id: string; label: string }> = [
  { id: "sqlcortex.login", label: "Login" },
  { id: "sqlcortex.logout", label: "Logout" },
  { id: "sqlcortex.selectOrg", label: "Select Org" },
  { id: "sqlcortex.selectProject", label: "Select Project" },
  { id: "sqlcortex.runQuery", label: "Run Query" },
  { id: "sqlcortex.runSelection", label: "Run Selection" }
];

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("SQLCortex");
  output.appendLine("SQLCortex extension activated.");
  context.subscriptions.push(output);

  for (const command of COMMANDS) {
    const disposable = vscode.commands.registerCommand(command.id, () => {
      output.appendLine(`Command executed: ${command.id}`);
      vscode.window.showInformationMessage(`SQLCortex: ${command.label} (not yet implemented)`);
    });
    context.subscriptions.push(disposable);
  }
}

export function deactivate() {}
