import type { DbCopilotOptimizationPlan } from "../dbcopilot/orchestrator";

export function buildDbCopilotOptimizationPlanHtml(
  plan: DbCopilotOptimizationPlan | null
): string {
  const title = plan ? "Optimization Plan" : "Optimization Plan (No Data)";
  const steps = plan?.orchestrator.plan ?? [];
  const missing = plan?.orchestrator.missing_context ?? [];
  const summary = plan?.merged.risk_impact?.summary ?? [];
  const sqlPreview = plan?.merged.sql_preview ?? null;
  const explanation = plan?.merged.explanation_markdown ?? null;

  const stepRows = steps.length
    ? steps
        .map(
          (step) =>
            `<tr><td>${escapeHtml(step.step_id)}</td><td>${escapeHtml(
              formatAgent(step.agent)
            )}</td><td>${escapeHtml(step.objective)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3">No steps available.</td></tr>`;

  const missingItems = missing.length
    ? `<ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>None</p>";

  const summaryItems = summary.length
    ? `<ul>${summary
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</li>`
        )
        .join("")}</ul>`
    : "<p>No risk summary available.</p>";

  const upSql = sqlPreview ? escapeHtml(sqlPreview.upSql) : "No SQL generated.";
  const downSql = sqlPreview ? escapeHtml(sqlPreview.downSql) : "No rollback SQL.";

  const explanationBlock = explanation
    ? `<pre class="markdown">${escapeHtml(explanation)}</pre>`
    : "<p>No explainability output yet.</p>";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 24px;
        background: var(--vscode-editor-background);
      }
      h1 {
        font-size: 20px;
        margin: 0 0 8px;
      }
      h2 {
        margin-top: 24px;
        font-size: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 12px;
      }
      th,
      td {
        border: 1px solid var(--vscode-panel-border);
        padding: 8px 10px;
        text-align: left;
        font-size: 12px;
      }
      th {
        background: var(--vscode-editorWidget-background);
      }
      pre {
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border);
        padding: 12px;
        border-radius: 6px;
        overflow-x: auto;
        font-size: 12px;
        white-space: pre-wrap;
      }
      .markdown {
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>Intent: ${escapeHtml(plan?.orchestrator.intent ?? "unknown")}</p>

    <h2>Plan Steps</h2>
    <table>
      <thead>
        <tr>
          <th>Step</th>
          <th>Agent</th>
          <th>Objective</th>
        </tr>
      </thead>
      <tbody>
        ${stepRows}
      </tbody>
    </table>

    <h2>Missing Context</h2>
    ${missingItems}

    <h2>Risk & Impact</h2>
    ${summaryItems}

    <h2>SQL Preview</h2>
    <h3>Up</h3>
    <pre>${upSql}</pre>
    <h3>Down</h3>
    <pre>${downSql}</pre>

    <h2>Explainability</h2>
    ${explanationBlock}
  </body>
</html>`;
}

function formatAgent(agent: string): string {
  if (agent === "ddl") {
    return "DDL";
  }
  if (agent === "schema_analyst") {
    return "Schema Analyst";
  }
  return agent
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
