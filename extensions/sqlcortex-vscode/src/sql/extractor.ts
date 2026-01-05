import * as vscode from "vscode";

export type SqlSource = "selection" | "document";
export type ExtractMode = "selection" | "document" | "smart";

export type ExtractedSql = {
  sql: string;
  source: SqlSource;
};

export function extractSql(
  editor: vscode.TextEditor,
  mode: ExtractMode = "smart"
): ExtractedSql {
  const selectionText = editor.selection.isEmpty
    ? ""
    : editor.document.getText(editor.selection);

  if (mode === "selection") {
    return { sql: normalizeSql(selectionText), source: "selection" };
  }

  if (mode === "document") {
    return { sql: normalizeSql(editor.document.getText()), source: "document" };
  }

  if (selectionText.trim().length > 0) {
    return { sql: normalizeSql(selectionText), source: "selection" };
  }

  return { sql: normalizeSql(editor.document.getText()), source: "document" };
}

function normalizeSql(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
