import * as vscode from "vscode";
import type { IntelligenceScoreResponse } from "../api/types";

export type IntelligenceDecorationSnapshot = {
  anchorRange: vscode.Range;
  statementRange: vscode.Range;
  result: IntelligenceScoreResponse;
};

function riskBadgePrefix(level: IntelligenceScoreResponse["risk_level"]): string {
  switch (level) {
    case "Dangerous":
      return "[!]";
    case "Warning":
      return "[~]";
    case "Safe":
      return "[OK]";
    default:
      return "[?]";
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

function scoreBadgeBackground(score: number): string {
  if (score >= 90) {
    return "var(--vscode-testing-peekItemResultPassedBackground)";
  }
  if (score >= 70) {
    return "var(--vscode-editorInfo-background)";
  }
  if (score >= 50) {
    return "var(--vscode-editorWarning-background)";
  }
  return "var(--vscode-inputValidation-errorBackground)";
}

function riskBadgeBackground(level: IntelligenceScoreResponse["risk_level"]): string {
  switch (level) {
    case "Dangerous":
      return "var(--vscode-inputValidation-errorBackground)";
    case "Warning":
      return "var(--vscode-editorWarning-background)";
    case "Safe":
      return "var(--vscode-testing-peekItemResultPassedBackground)";
    default:
      return "var(--vscode-editorWidget-background)";
  }
}

function costBadgeColor(bucket: IntelligenceScoreResponse["cost_bucket"]): string {
  switch (bucket) {
    case "Low":
      return "var(--vscode-testing-iconPassed)";
    case "Medium":
      return "var(--vscode-editorWarning-foreground)";
    case "High":
    case "Extreme":
      return "var(--vscode-errorForeground)";
    default:
      return "var(--vscode-descriptionForeground)";
  }
}

function costBadgeBackground(bucket: IntelligenceScoreResponse["cost_bucket"]): string {
  switch (bucket) {
    case "Low":
      return "var(--vscode-testing-peekItemResultPassedBackground)";
    case "Medium":
      return "var(--vscode-editorWarning-background)";
    case "High":
    case "Extreme":
      return "var(--vscode-inputValidation-errorBackground)";
    default:
      return "var(--vscode-editorWidget-background)";
  }
}

function complexityBadgeColor(
  rating: IntelligenceScoreResponse["complexity_rating"]
): string {
  switch (rating) {
    case "Simple":
      return "var(--vscode-testing-iconPassed)";
    case "Moderate":
      return "var(--vscode-editorWarning-foreground)";
    case "Complex":
      return "var(--vscode-errorForeground)";
    default:
      return "var(--vscode-descriptionForeground)";
  }
}

function complexityBadgeBackground(
  rating: IntelligenceScoreResponse["complexity_rating"]
): string {
  switch (rating) {
    case "Simple":
      return "var(--vscode-testing-peekItemResultPassedBackground)";
    case "Moderate":
      return "var(--vscode-editorWarning-background)";
    case "Complex":
      return "var(--vscode-inputValidation-errorBackground)";
    default:
      return "var(--vscode-editorWidget-background)";
  }
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

function approximateBadgeWidthEm(text: string): number {
  // Decoration attachments are rendered with a proportional UI font in many themes.
  // Using `ch` can overestimate width, so we use an approximate per-character `em` width.
  return Math.max(3, text.length * 0.58);
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
    const scoreText = `Score ${snapshot.result.performance_score}/100`;
    const riskText = `${riskBadgePrefix(snapshot.result.risk_level)} ${snapshot.result.risk_level}`;
    const costText = `Cost ${snapshot.result.cost_bucket}`;
    const complexityText = `Complexity ${snapshot.result.complexity_rating}`;
    const badgeGapEm = 0.25;
    const scoreOffsetEm = 0.5;
    const riskOffsetEm = scoreOffsetEm + approximateBadgeWidthEm(scoreText) + badgeGapEm;
    const costOffsetEm = riskOffsetEm + approximateBadgeWidthEm(riskText) + badgeGapEm;
    const complexityOffsetEm = costOffsetEm + approximateBadgeWidthEm(costText) + badgeGapEm;

    const shared = { range: snapshot.anchorRange };
    editor.setDecorations(this.scoreDecoration, [
      {
        ...shared,
        renderOptions: {
          after: {
            contentText: scoreText,
            color: scoreBadgeColor(snapshot.result.performance_score),
            backgroundColor: scoreBadgeBackground(snapshot.result.performance_score),
            margin: `0 0 0 ${scoreOffsetEm}em`,
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
            backgroundColor: riskBadgeBackground(snapshot.result.risk_level),
            margin: `0 0 0 ${riskOffsetEm}em`,
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
            color: costBadgeColor(snapshot.result.cost_bucket),
            backgroundColor: costBadgeBackground(snapshot.result.cost_bucket),
            margin: `0 0 0 ${costOffsetEm}em`,
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
            color: complexityBadgeColor(snapshot.result.complexity_rating),
            backgroundColor: complexityBadgeBackground(snapshot.result.complexity_rating),
            margin: `0 0 0 ${complexityOffsetEm}em`,
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
