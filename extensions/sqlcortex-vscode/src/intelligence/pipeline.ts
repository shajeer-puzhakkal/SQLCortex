import * as vscode from "vscode";
import {
  evaluateQueryFeatures,
  extractQueryFeatures,
  type IntelligenceResult,
} from "../../../../packages/intelligence/src";
import {
  hashSql,
  normalizeSql as normalizeSqlForHash,
} from "../../../../packages/shared/src/sql";
import type { IntelligenceScoreResponse } from "../api/types";
import {
  IntelligenceDecorations,
  type IntelligenceDecorationSnapshot,
} from "./decorations";
import { getActiveStatement, type ActiveStatement } from "../sql/getActiveStatement";

const SQL_LANGUAGES = new Set(["sql", "pgsql", "mssql"]);
const DEFAULT_DEBOUNCE_MS = 500;

export type ActiveStatementContext = {
  editor: vscode.TextEditor;
  documentUri: string;
  documentVersion: number;
  statement: ActiveStatement;
  statementRange: vscode.Range;
  anchorRange: vscode.Range;
  fingerprint: string;
};

export type ActiveStatementIntelligence = {
  documentUri: string;
  documentVersion: number;
  statement: ActiveStatement;
  statementRange: vscode.Range;
  badgeRanges: readonly vscode.Range[];
  mode: "fast" | "plan";
  fingerprint: string;
  result: IntelligenceScoreResponse;
  updatedAt: number;
};

type IntelligencePipelineOptions = {
  decorations: IntelligenceDecorations;
  output: vscode.OutputChannel;
  getRealtimeEnabled: () => boolean;
  getDebounceMs: () => number;
  onSnapshot?: (snapshot: ActiveStatementIntelligence | null) => void;
};

function toScoreResponse(result: IntelligenceResult): IntelligenceScoreResponse {
  return {
    version: result.version,
    performance_score: result.performance_score,
    performance_label: result.performance_label,
    cost_bucket: result.cost_bucket,
    risk_level: result.risk_level,
    complexity_rating: result.complexity_rating,
    reasons: [...result.reasons],
    recommendations: [...result.recommendations],
    risk_reasons: result.risk_reasons ? [...result.risk_reasons] : undefined,
    risk_gate: result.risk_gate,
    plan_summary: result.plan_summary,
  };
}

function documentOffsetToNormalizedOffset(text: string, documentOffset: number): number {
  const safeOffset = Math.max(0, Math.min(documentOffset, text.length));
  let normalizedOffset = 0;

  for (let index = 0; index < safeOffset; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (current === "\r" && next === "\n") {
      continue;
    }

    normalizedOffset += 1;
  }

  return normalizedOffset;
}

function normalizedOffsetToDocumentOffset(text: string, normalizedOffset: number): number {
  const normalizedLength = text.replace(/\r\n/g, "\n").length;
  const safeOffset = Math.max(0, Math.min(normalizedOffset, normalizedLength));
  let traversed = 0;
  let documentOffset = 0;

  while (documentOffset < text.length && traversed < safeOffset) {
    const current = text[documentOffset];
    const next = text[documentOffset + 1];

    if (current === "\r" && next === "\n") {
      documentOffset += 1;
    }

    documentOffset += 1;
    traversed += 1;
  }

  return documentOffset;
}

function buildAnchorRange(
  editor: vscode.TextEditor,
  statement: ActiveStatement,
  documentText: string
): vscode.Range {
  const firstLineLength = statement.sql.indexOf("\n");
  const normalizedLineEnd =
    statement.start + (firstLineLength === -1 ? statement.sql.length : firstLineLength);
  const documentStartOffset = normalizedOffsetToDocumentOffset(documentText, statement.start);
  const documentLineEndOffset = normalizedOffsetToDocumentOffset(documentText, normalizedLineEnd);
  const anchorStartOffset = Math.max(documentStartOffset, documentLineEndOffset - 1);
  const anchorStart = editor.document.positionAt(anchorStartOffset);
  const anchorEnd = editor.document.positionAt(documentLineEndOffset);

  return new vscode.Range(anchorStart, anchorEnd);
}

function isSqlEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
  return Boolean(editor && SQL_LANGUAGES.has(editor.document.languageId));
}

function areIntelligenceResultsEqual(
  left: IntelligenceScoreResponse,
  right: IntelligenceScoreResponse
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateLocalFastIntelligence(sql: string): IntelligenceScoreResponse {
  const features = extractQueryFeatures(sql);
  return toScoreResponse(
    evaluateQueryFeatures(features, {
      mode: "fast",
      queryText: sql,
    })
  );
}

export class IntelligencePipeline implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private snapshot: ActiveStatementIntelligence | null = null;
  private decoratedEditor: vscode.TextEditor | null = null;

  constructor(private readonly options: IntelligencePipelineOptions) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.decoratedEditor && this.decoratedEditor !== editor) {
          this.options.decorations.clear(this.decoratedEditor);
          this.decoratedEditor = null;
        }

        if (!isSqlEditor(editor)) {
          this.updateSnapshot(null);
          return;
        }

        this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("sqlcortex.intelligence.realTimeScoringEnabled") ||
          event.affectsConfiguration("sqlcortex.intelligence.debounceMs")
        ) {
          if (!this.options.getRealtimeEnabled()) {
            this.clearActiveEditor();
            return;
          }

          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.snapshot?.documentUri === document.uri.toString()) {
          this.clearActiveEditor();
        }
      })
    );
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.decoratedEditor) {
      this.options.decorations.clear(this.decoratedEditor);
      this.decoratedEditor = null;
    }
    this.updateSnapshot(null);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  requestImmediateRefresh(): void {
    if (!this.options.getRealtimeEnabled()) {
      return;
    }
    void this.scoreCurrentQueryFast();
  }

  scheduleRefresh(): void {
    if (!this.options.getRealtimeEnabled()) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const delay = Math.max(400, Math.min(600, this.options.getDebounceMs() || DEFAULT_DEBOUNCE_MS));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scoreCurrentQueryFast();
    }, delay);
  }

  clearActiveEditor(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.decoratedEditor) {
      this.options.decorations.clear(this.decoratedEditor);
      this.decoratedEditor = null;
    } else if (vscode.window.activeTextEditor) {
      this.options.decorations.clear(vscode.window.activeTextEditor);
    }
    this.updateSnapshot(null);
  }

  getSnapshotForDocument(
    document: vscode.TextDocument
  ): ActiveStatementIntelligence | null {
    if (this.snapshot?.documentUri !== document.uri.toString()) {
      return null;
    }
    return this.snapshot;
  }

  getHoverSnapshot(
    document: vscode.TextDocument,
    position: vscode.Position
  ): ActiveStatementIntelligence | null {
    const snapshot = this.getSnapshotForDocument(document);
    if (!snapshot) {
      return null;
    }

    for (const range of snapshot.badgeRanges) {
      if (range.contains(position)) {
        return snapshot;
      }
    }

    return null;
  }

  getActiveStatementContext(
    editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
  ): ActiveStatementContext | null {
    if (!isSqlEditor(editor)) {
      return null;
    }

    const documentText = editor.document.getText();
    const documentCursorOffset = editor.document.offsetAt(editor.selection.active);
    const normalizedCursorOffset = documentOffsetToNormalizedOffset(
      documentText,
      documentCursorOffset
    );
    const statement = getActiveStatement(documentText, normalizedCursorOffset);
    if (!statement.sql.trim()) {
      return null;
    }

    const documentStartOffset = normalizedOffsetToDocumentOffset(documentText, statement.start);
    const documentEndOffset = normalizedOffsetToDocumentOffset(documentText, statement.end);
    const statementRange = new vscode.Range(
      editor.document.positionAt(documentStartOffset),
      editor.document.positionAt(documentEndOffset)
    );
    const anchorRange = buildAnchorRange(editor, statement, documentText);
    const fingerprint = hashSql(normalizeSqlForHash(statement.sql));

    return {
      editor,
      documentUri: editor.document.uri.toString(),
      documentVersion: editor.document.version,
      statement,
      statementRange,
      anchorRange,
      fingerprint,
    };
  }

  async scoreCurrentQueryFast(): Promise<ActiveStatementIntelligence | null> {
    const context = this.getActiveStatementContext();
    if (!context) {
      this.clearActiveEditor();
      return null;
    }

    const result = evaluateLocalFastIntelligence(context.statement.sql);
    return this.applyResult(context, result, "fast");
  }

  applyExternalResult(
    context: ActiveStatementContext,
    result: IntelligenceScoreResponse,
    mode: "fast" | "plan"
  ): ActiveStatementIntelligence | null {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return null;
    }

    if (activeEditor.document.uri.toString() !== context.documentUri) {
      return null;
    }

    if (activeEditor.document.version !== context.documentVersion) {
      return null;
    }

    return this.applyResult({ ...context, editor: activeEditor }, result, mode);
  }

  private applyResult(
    context: ActiveStatementContext,
    result: IntelligenceScoreResponse,
    mode: "fast" | "plan"
  ): ActiveStatementIntelligence {
    const current = this.snapshot;
    if (
      current &&
      current.documentUri === context.documentUri &&
      current.documentVersion === context.documentVersion &&
      current.fingerprint === context.fingerprint &&
      current.mode === mode &&
      areIntelligenceResultsEqual(current.result, result)
    ) {
      return current;
    }

    const decorationSnapshot: IntelligenceDecorationSnapshot = {
      anchorRange: context.anchorRange,
      statementRange: context.statementRange,
      result,
    };
    const badgeRanges = this.options.decorations.render(context.editor, decorationSnapshot);
    this.decoratedEditor = context.editor;

    const next: ActiveStatementIntelligence = {
      documentUri: context.documentUri,
      documentVersion: context.documentVersion,
      statement: context.statement,
      statementRange: context.statementRange,
      badgeRanges,
      mode,
      fingerprint: context.fingerprint,
      result,
      updatedAt: Date.now(),
    };
    this.updateSnapshot(next);
    if (mode === "plan") {
      this.options.output.appendLine(
        `SQLCortex intelligence: plan score updated (${context.fingerprint.slice(0, 12)}).`
      );
    }
    return next;
  }

  private updateSnapshot(snapshot: ActiveStatementIntelligence | null): void {
    this.snapshot = snapshot;
    this.options.onSnapshot?.(snapshot);
  }
}
