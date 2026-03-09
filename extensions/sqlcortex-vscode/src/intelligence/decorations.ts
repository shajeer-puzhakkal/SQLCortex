import * as vscode from "vscode";
import type { IntelligenceScoreResponse } from "../api/types";

export type IntelligenceDecorationSnapshot = {
  anchorRange: vscode.Range;
  statementRange: vscode.Range;
  result: IntelligenceScoreResponse;
};

function riskBadgeIcon(level: IntelligenceScoreResponse["risk_level"]): string {
  switch (level) {
    case "Dangerous":
      return "$(error)";
    case "Warning":
      return "$(warning)";
    case "Safe":
      return "$(check)";
    default:
      return "$(question)";
  }
}

function riskBadgeColor(level: IntelligenceScoreResponse["risk_level"]): string {
  switch (level) {
    case "Dangerous":
      return "var(--vscode-errorForeground)";
    case "Warning":
      return "var(--vscode-editorWarning-foreground)";
    case "Safe":
      return "var(--vscode-testing-iconPassed)";
    default:
      return "var(--vscode-descriptionForeground)";
  }
}

function scoreBadgeColor(score: number): string {
  if (score >= 90) {
    return "var(--vscode-testing-iconPassed)";
  }
  if (score >= 70) {
    return "var(--vscode-charts-blue)";
  }
  if (score >= 50) {
    return "var(--vscode-editorWarning-foreground)";
  }
  return "var(--vscode-errorForeground)";
}

function createBadgeDecoration(baseBackground: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      color: "var(--vscode-editor-foreground)",
      backgroundColor: baseBackground,
      border: "1px solid var(--vscode-editorWidget-border)",
      margin: "0 0 0 0.75rem",
      fontWeight: "600",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

export class IntelligenceDecorations implements vscode.Disposable {
  private readonly scoreDecoration = createBadgeDecoration(
    "var(--vscode-editorInfo-background)"
  );

  private readonly riskDecoration = createBadgeDecoration(
    "var(--vscode-editorWarning-background)"
  );

  private readonly costDecoration = createBadgeDecoration(
    "var(--vscode-editorWidget-background)"
  );

  private readonly complexityDecoration = createBadgeDecoration(
    "var(--vscode-editorWidget-background)"
  );

  render(
    editor: vscode.TextEditor,
    snapshot: IntelligenceDecorationSnapshot
  ): readonly vscode.Range[] {
    const scoreText = ` Score ${snapshot.result.performance_score}/100 `;
    const riskText = ` ${riskBadgeIcon(snapshot.result.risk_level)} ${snapshot.result.risk_level} `;
    const costText = ` Cost ${snapshot.result.cost_bucket} `;
    const complexityText = ` Complexity ${snapshot.result.complexity_rating} `;

    const shared = { range: snapshot.anchorRange };
    editor.setDecorations(this.scoreDecoration, [
      {
        ...shared,
        renderOptions: {
          after: {
            contentText: scoreText,
            color: scoreBadgeColor(snapshot.result.performance_score),
          },
        },
      },
    ]);
    editor.setDecorations(this.riskDecoration, [
      {
        ...shared,
        renderOptions: {
          after: {
            contentText: riskText,
            color: riskBadgeColor(snapshot.result.risk_level),
            margin: "0 0 0 6.5rem",
          },
        },
      },
    ]);
    editor.setDecorations(this.costDecoration, [
      {
        ...shared,
        renderOptions: {
          after: {
            contentText: costText,
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 0 13rem",
          },
        },
      },
    ]);
    editor.setDecorations(this.complexityDecoration, [
      {
        ...shared,
        renderOptions: {
          after: {
            contentText: complexityText,
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 0 18.25rem",
          },
        },
      },
    ]);

    return [snapshot.anchorRange];
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.scoreDecoration, []);
    editor.setDecorations(this.riskDecoration, []);
    editor.setDecorations(this.costDecoration, []);
    editor.setDecorations(this.complexityDecoration, []);
  }

  dispose(): void {
    this.scoreDecoration.dispose();
    this.riskDecoration.dispose();
    this.costDecoration.dispose();
    this.complexityDecoration.dispose();
  }
}
