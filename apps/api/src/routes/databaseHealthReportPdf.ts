import type {
  DatabaseHealthIndexFinding,
  DatabaseHealthSchemaRisk,
  DatabaseHealthScoreBreakdown,
  DatabaseHealthSlowQuery,
} from "../contracts";

type PuppeteerPage = {
  setContent: (
    html: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" },
  ) => Promise<void>;
  pdf: (options?: {
    format?: "A4";
    printBackground?: boolean;
    margin?: { top: string; right: string; bottom: string; left: string };
  }) => Promise<Buffer>;
};

type PuppeteerBrowser = {
  newPage: () => Promise<PuppeteerPage>;
  close: () => Promise<void>;
};

type PuppeteerModule = {
  launch: (options?: { headless?: boolean | "new"; args?: string[] }) => Promise<PuppeteerBrowser>;
};

export type DatabaseHealthReportPdfInput = {
  projectName: string;
  reportWeekStartIso: string;
  generatedAtIso: string;
  healthScore: number;
  scoreBreakdown: DatabaseHealthScoreBreakdown;
  topSlowQueries: DatabaseHealthSlowQuery[];
  missingIndexes: DatabaseHealthIndexFinding[];
  unusedIndexes: DatabaseHealthIndexFinding[];
  schemaRisks: DatabaseHealthSchemaRisk[];
  aiSummary: string;
};

const FALLBACK_PAGE_MAX_LINES = 52;

export async function renderDatabaseHealthReportPdf(input: DatabaseHealthReportPdfInput): Promise<Buffer> {
  const puppeteer = loadPuppeteerModule();
  if (puppeteer) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(buildReportHtml(input), { waitUntil: "networkidle0" });
        return await page.pdf({
          format: "A4",
          printBackground: true,
          margin: {
            top: "24px",
            right: "24px",
            bottom: "24px",
            left: "24px",
          },
        });
      } finally {
        await browser.close();
      }
    } catch (err) {
      console.warn("Puppeteer PDF export failed; falling back to built-in renderer", err);
    }
  }

  return buildFallbackPdf(input);
}

export function buildDatabaseHealthPdfFileName(projectName: string): string {
  const normalized = sanitizeFileToken(projectName);
  const token = normalized.length > 0 ? normalized : "Project";
  return `SQLCortex_Health_Report_${token}.pdf`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPuppeteerModule(value: unknown): value is PuppeteerModule {
  return isRecord(value) && typeof value.launch === "function";
}

function loadPuppeteerModule(): PuppeteerModule | null {
  try {
    const dynamicRequire = Function("return require")() as (id: string) => unknown;
    const loaded = dynamicRequire("puppeteer");
    if (isPuppeteerModule(loaded)) {
      return loaded;
    }
    if (isRecord(loaded) && isPuppeteerModule(loaded.default)) {
      return loaded.default;
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeFileToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .slice(0, 64);
}

function buildReportHtml(input: DatabaseHealthReportPdfInput): string {
  const topSlowRows = input.topSlowQueries
    .slice(0, 10)
    .map(
      (query, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><code>${escapeHtml(query.query_id ?? "n/a")}</code></td>
        <td>${escapeHtml(query.query_text)}</td>
        <td>${query.calls}</td>
        <td>${query.mean_exec_time_ms}</td>
        <td>${query.total_exec_time_ms}</td>
      </tr>`,
    )
    .join("");
  const missingRows = input.missingIndexes
    .slice(0, 20)
    .map((finding) => `<li><code>${escapeHtml(finding.index_name)}</code> - ${escapeHtml(finding.recommendation)}</li>`)
    .join("");
  const unusedRows = input.unusedIndexes
    .slice(0, 20)
    .map((finding) => `<li><code>${escapeHtml(finding.index_name)}</code> - ${escapeHtml(finding.recommendation)}</li>`)
    .join("");
  const schemaRiskRows = input.schemaRisks
    .slice(0, 20)
    .map(
      (risk) => `
      <tr>
        <td>${escapeHtml(risk.detected_at.slice(0, 10))}</td>
        <td>${escapeHtml(risk.change_type)}</td>
        <td><code>${escapeHtml(risk.object_name)}</code></td>
        <td>${escapeHtml(risk.risk_level)}</td>
        <td>${escapeHtml(risk.recommendation)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SQLCortex Health Report</title>
    <style>
      :root {
        --ink: #0f172a;
        --muted: #475569;
        --line: #dbe3ee;
        --bg-soft: #f8fafc;
        --accent: #1d4ed8;
      }
      body {
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        color: var(--ink);
        margin: 0;
      }
      main {
        padding: 10px 6px;
      }
      h1, h2 {
        margin: 0 0 8px;
      }
      h1 {
        font-size: 24px;
      }
      h2 {
        margin-top: 18px;
        font-size: 16px;
        color: var(--accent);
      }
      p.meta {
        margin: 2px 0;
        color: var(--muted);
        font-size: 12px;
      }
      p.summary {
        margin: 10px 0 0;
        padding: 10px;
        border: 1px solid var(--line);
        background: var(--bg-soft);
        border-radius: 6px;
        font-size: 12px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
        font-size: 11px;
      }
      th, td {
        border: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        padding: 6px;
      }
      th {
        background: var(--bg-soft);
      }
      ul {
        margin: 8px 0 0;
        padding-left: 18px;
        font-size: 12px;
      }
      li {
        margin-bottom: 4px;
      }
      code {
        font-family: "Consolas", "Courier New", monospace;
        font-size: 11px;
      }
      .score-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }
      .score-card {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
        background: var(--bg-soft);
      }
      .score-label {
        color: var(--muted);
        font-size: 11px;
      }
      .score-value {
        font-size: 16px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>SQLCortex Database Health Report</h1>
      <p class="meta"><strong>Project:</strong> ${escapeHtml(input.projectName)}</p>
      <p class="meta"><strong>Week Start:</strong> ${escapeHtml(input.reportWeekStartIso.slice(0, 10))}</p>
      <p class="meta"><strong>Generated:</strong> ${escapeHtml(input.generatedAtIso)}</p>
      <p class="meta"><strong>Overall Health Score:</strong> ${input.healthScore}/100</p>

      <p class="summary">${escapeHtml(input.aiSummary)}</p>

      <h2>Score Breakdown</h2>
      <div class="score-grid">
        <div class="score-card">
          <div class="score-label">Query Performance</div>
          <div class="score-value">${input.scoreBreakdown.query_performance}</div>
        </div>
        <div class="score-card">
          <div class="score-label">Schema Quality</div>
          <div class="score-value">${input.scoreBreakdown.schema_quality}</div>
        </div>
        <div class="score-card">
          <div class="score-label">Index Efficiency</div>
          <div class="score-value">${input.scoreBreakdown.index_efficiency}</div>
        </div>
        <div class="score-card">
          <div class="score-label">Lock Contention</div>
          <div class="score-value">${input.scoreBreakdown.lock_contention}</div>
        </div>
      </div>

      <h2>Top Slow Queries</h2>
      ${
        topSlowRows.length > 0
          ? `<table>
            <thead>
              <tr>
                <th>#</th>
                <th>Query ID</th>
                <th>Query</th>
                <th>Calls</th>
                <th>Mean (ms)</th>
                <th>Total (ms)</th>
              </tr>
            </thead>
            <tbody>${topSlowRows}</tbody>
          </table>`
          : "<p class=\"meta\">No slow-query findings for this window.</p>"
      }

      <h2>Missing Indexes</h2>
      ${missingRows.length > 0 ? `<ul>${missingRows}</ul>` : "<p class=\"meta\">No missing index findings.</p>"}

      <h2>Unused Indexes</h2>
      ${unusedRows.length > 0 ? `<ul>${unusedRows}</ul>` : "<p class=\"meta\">No unused index findings.</p>"}

      <h2>Schema Risks</h2>
      ${
        schemaRiskRows.length > 0
          ? `<table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Change</th>
                <th>Object</th>
                <th>Risk</th>
                <th>Recommendation</th>
              </tr>
            </thead>
            <tbody>${schemaRiskRows}</tbody>
          </table>`
          : "<p class=\"meta\">No schema risk events for this window.</p>"
      }
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFallbackPdf(input: DatabaseHealthReportPdfInput): Buffer {
  const wrappedLines = buildFallbackLines(input)
    .flatMap((line) => (line.length === 0 ? [""] : wrapLine(line, 92)))
    .slice(0, FALLBACK_PAGE_MAX_LINES);
  if (wrappedLines.length === FALLBACK_PAGE_MAX_LINES) {
    wrappedLines[FALLBACK_PAGE_MAX_LINES - 1] = "...truncated (install puppeteer for full rich export)...";
  }

  const contentLines = ["BT", "/F1 10 Tf", "50 792 Td", "14 TL"];
  for (let index = 0; index < wrappedLines.length; index += 1) {
    if (index > 0) {
      contentLines.push("T*");
    }
    contentLines.push(`(${escapePdfText(wrappedLines[index] ?? "")}) Tj`);
  }
  contentLines.push("ET");

  return composeSinglePagePdf(contentLines.join("\n"));
}

function buildFallbackLines(input: DatabaseHealthReportPdfInput): string[] {
  const lines = [
    "SQLCortex Database Health Report",
    `Project: ${input.projectName}`,
    `Week start: ${input.reportWeekStartIso.slice(0, 10)}`,
    `Generated: ${input.generatedAtIso}`,
    `Overall score: ${input.healthScore}/100`,
    "",
    "Score Breakdown",
    `Query performance: ${input.scoreBreakdown.query_performance}`,
    `Schema quality: ${input.scoreBreakdown.schema_quality}`,
    `Index efficiency: ${input.scoreBreakdown.index_efficiency}`,
    `Lock contention: ${input.scoreBreakdown.lock_contention}`,
    "",
    "AI Summary",
    input.aiSummary,
    "",
    "Top Slow Queries",
  ];

  if (input.topSlowQueries.length === 0) {
    lines.push("None");
  } else {
    for (const query of input.topSlowQueries.slice(0, 8)) {
      lines.push(`- ${query.query_id ?? "n/a"} | calls=${query.calls} | mean_ms=${query.mean_exec_time_ms}`);
      lines.push(`  ${query.query_text}`);
    }
  }

  lines.push("", "Missing Indexes");
  if (input.missingIndexes.length === 0) {
    lines.push("None");
  } else {
    for (const finding of input.missingIndexes.slice(0, 12)) {
      lines.push(`- ${finding.index_name}: ${finding.recommendation}`);
    }
  }

  lines.push("", "Unused Indexes");
  if (input.unusedIndexes.length === 0) {
    lines.push("None");
  } else {
    for (const finding of input.unusedIndexes.slice(0, 12)) {
      lines.push(`- ${finding.index_name}: ${finding.recommendation}`);
    }
  }

  lines.push("", "Schema Risks");
  if (input.schemaRisks.length === 0) {
    lines.push("None");
  } else {
    for (const risk of input.schemaRisks.slice(0, 12)) {
      lines.push(
        `- ${risk.detected_at.slice(0, 10)} | ${risk.risk_level} | ${risk.change_type} | ${risk.object_name}`,
      );
      lines.push(`  ${risk.recommendation}`);
    }
  }

  return lines;
}

function wrapLine(line: string, width: number): string[] {
  const compact = line.replace(/\s+/g, " ").trim();
  if (compact.length <= width) {
    return [compact];
  }
  const tokens = compact.split(" ");
  const chunks: string[] = [];
  let active = "";
  for (const token of tokens) {
    let remaining = token;
    while (remaining.length > width) {
      if (active.length > 0) {
        chunks.push(active);
        active = "";
      }
      chunks.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    const next = active.length === 0 ? remaining : `${active} ${remaining}`;
    if (next.length <= width) {
      active = next;
      continue;
    }
    if (active.length > 0) {
      chunks.push(active);
    }
    active = remaining;
  }
  if (active.length > 0) {
    chunks.push(active);
  }
  return chunks.length > 0 ? chunks : [compact.slice(0, width)];
}

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");
}

function composeSinglePagePdf(contentStream: string): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let documentText = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const objectText of objects) {
    offsets.push(Buffer.byteLength(documentText, "utf8"));
    documentText += objectText;
  }

  const xrefOffset = Buffer.byteLength(documentText, "utf8");
  documentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    documentText += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  documentText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(documentText, "utf8");
}
