import * as vscode from "vscode";

const SELECT_STAR_PATTERN = /\bselect\s+\*/gi;

export function createSqlDiagnosticsCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection("sqlcortex");
}

export function updateSqlDiagnostics(params: {
  collection: vscode.DiagnosticCollection;
  document: vscode.TextDocument;
  selection: vscode.Selection;
  sql: string;
  enabled: boolean;
}): void {
  const { collection, document, selection, sql, enabled } = params;
  if (!enabled) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];
  SELECT_STAR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = SELECT_STAR_PATTERN.exec(sql);
  const baseOffset = document.offsetAt(selection.start);

  while (match) {
    const start = document.positionAt(baseOffset + match.index);
    const end = document.positionAt(baseOffset + match.index + match[0].length);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(start, end),
      "Avoid SELECT *; project only needed columns.",
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = "sqlcortex.selectStar";
    diagnostics.push(diagnostic);
    match = SELECT_STAR_PATTERN.exec(sql);
  }

  collection.set(document.uri, diagnostics);
}
