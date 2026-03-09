import * as vscode from "vscode";
import type { IntelligenceScoreResponse } from "../api/types";
import { IntelligencePipeline } from "./pipeline";

const SQL_SELECTOR: vscode.DocumentSelector = [
  { language: "sql", scheme: "file" },
  { language: "sql", scheme: "untitled" },
  { language: "pgsql", scheme: "file" },
  { language: "pgsql", scheme: "untitled" },
  { language: "mssql", scheme: "file" },
  { language: "mssql", scheme: "untitled" },
];

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function appendReasons(
  markdown: vscode.MarkdownString,
  result: IntelligenceScoreResponse
): void {
  if (result.reasons.length === 0) {
    markdown.appendMarkdown("\n_No scoring deductions detected._\n");
    return;
  }

  markdown.appendMarkdown("\n**Reasons**\n");
  for (const reason of result.reasons.slice(0, 8)) {
    markdown.appendMarkdown(
      `- \`${reason.code}\` (${formatDelta(reason.delta)}): ${reason.message}\n`
    );
  }
}

function appendRecommendations(
  markdown: vscode.MarkdownString,
  result: IntelligenceScoreResponse
): void {
  if (result.recommendations.length === 0) {
    return;
  }

  markdown.appendMarkdown("\n**Recommendations**\n");
  for (const recommendation of result.recommendations.slice(0, 4)) {
    markdown.appendMarkdown(
      `- ${recommendation.message} (${Math.round(recommendation.confidence * 100)}% confidence)\n`
    );
  }
}

function appendRiskNotes(
  markdown: vscode.MarkdownString,
  result: IntelligenceScoreResponse
): void {
  if (!result.risk_reasons || result.risk_reasons.length === 0) {
    return;
  }
  markdown.appendMarkdown("\n**Risk Notes**\n");
  for (const reason of result.risk_reasons.slice(0, 4)) {
    markdown.appendMarkdown(`- \`${reason.code}\`: ${reason.message}\n`);
  }
}

function buildHoverMarkdown(
  result: IntelligenceScoreResponse,
  planCommandId: string
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = true;
  markdown.appendMarkdown("**SQLCortex Intelligence**\n\n");
  markdown.appendMarkdown(
    `Score: **${result.performance_score}/100** (${result.performance_label})  \n`
  );
  markdown.appendMarkdown(`Risk: **${result.risk_level}**  \n`);
  markdown.appendMarkdown(`Cost: **${result.cost_bucket}**  \n`);
  markdown.appendMarkdown(`Complexity: **${result.complexity_rating}**\n`);
  appendReasons(markdown, result);
  appendRecommendations(markdown, result);
  appendRiskNotes(markdown, result);
  markdown.appendMarkdown(
    `\n[Run Plan Scoring](command:${planCommandId})`
  );
  return markdown;
}

export function registerIntelligenceHoverProvider(options: {
  pipeline: IntelligencePipeline;
  planCommandId: string;
}): vscode.Disposable {
  return vscode.languages.registerHoverProvider(SQL_SELECTOR, {
    provideHover(document, position) {
      const snapshot = options.pipeline.getHoverSnapshot(document, position);
      if (!snapshot) {
        return null;
      }

      const markdown = buildHoverMarkdown(snapshot.result, options.planCommandId);
      const hoverRange = snapshot.badgeRanges[0] ?? snapshot.statementRange;
      return new vscode.Hover(markdown, hoverRange);
    },
  });
}
