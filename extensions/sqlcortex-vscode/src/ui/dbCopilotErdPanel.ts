import * as vscode from "vscode";
import type { DbCopilotSchemaSnapshot } from "../dbcopilot/schemaSnapshot";

type DbCopilotErdHtmlOptions = {
  webview: vscode.Webview;
  snapshot: DbCopilotSchemaSnapshot;
  mermaidUri: vscode.Uri;
  nonce: string;
};

export function buildDbCopilotErdHtml(options: DbCopilotErdHtmlOptions): string {
  const { webview, snapshot, mermaidUri, nonce } = options;
  const snapshotJson = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    "img-src data: blob:",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DB Copilot: ER Diagram</title>
    <style>
      :root {
        color-scheme: light dark;
        --surface: var(--vscode-editorWidget-background);
        --surface-border: var(--vscode-editorWidget-border);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-button-background);
        --accent-hover: var(--vscode-button-hoverBackground);
        --accent-text: var(--vscode-button-foreground);
        --warning: #e24c4b;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }

      .page {
        padding: 22px 26px 32px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
      }

      .title {
        font-size: 20px;
        font-weight: 600;
      }

      .subtitle {
        font-size: 12px;
        color: var(--muted);
      }

      .controls,
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .controls label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--surface-border);
        background: var(--surface);
      }

      .controls input {
        margin: 0;
      }

      .actions button {
        border: none;
        border-radius: 8px;
        padding: 8px 14px;
        font-size: 12px;
        cursor: pointer;
        background: var(--accent);
        color: var(--accent-text);
      }

      .actions button.secondary {
        background: transparent;
        border: 1px solid var(--surface-border);
        color: var(--vscode-editor-foreground);
      }

      .actions button:hover {
        background: var(--accent-hover);
      }

      .actions button.secondary:hover {
        background: var(--surface);
      }

      .diagram-shell {
        border: 1px solid var(--surface-border);
        border-radius: 14px;
        padding: 16px;
        background: var(--surface);
        min-height: 420px;
        overflow: auto;
      }

      #diagram {
        min-width: 720px;
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }

      .status.error {
        color: var(--warning);
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div class="title">ER Diagram</div>
        <div class="subtitle" id="schemaName"></div>
      </div>

      <div class="controls">
        <label><input id="toggleIndexes" type="checkbox" /> Show indexes</label>
        <label><input id="toggleRowCounts" type="checkbox" /> Show row counts</label>
        <label><input id="toggleMissingFks" type="checkbox" /> Highlight missing FKs</label>
      </div>

      <div class="actions">
        <button id="exportPng" type="button">Export PNG</button>
        <button id="copyMermaid" type="button" class="secondary">Copy Mermaid</button>
        <button id="openRecommendations" type="button" class="secondary">
          Open in Recommendations
        </button>
      </div>

      <div class="diagram-shell">
        <div id="diagram"></div>
      </div>

      <div id="status" class="status"></div>
    </div>

    <script nonce="${nonce}" src="${mermaidUri}"></script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const snapshot = ${snapshotJson};
      const MISSING_MARKER = "__missing_fk__";
      const state = {
        showIndexes: false,
        showRowCounts: false,
        highlightMissingFks: false,
      };

      const schemaName = document.getElementById("schemaName");
      const status = document.getElementById("status");
      const diagram = document.getElementById("diagram");
      const toggleIndexes = document.getElementById("toggleIndexes");
      const toggleRowCounts = document.getElementById("toggleRowCounts");
      const toggleMissingFks = document.getElementById("toggleMissingFks");
      const exportPng = document.getElementById("exportPng");
      const copyMermaid = document.getElementById("copyMermaid");
      const openRecommendations = document.getElementById("openRecommendations");

      if (schemaName) {
        schemaName.textContent = snapshot.schema ? "(" + snapshot.schema + ")" : "";
      }

      const tableIdByName = new Map();
      const tableById = new Map();
      for (const table of snapshot.tables || []) {
        const id = sanitizeIdentifier(table.name);
        tableIdByName.set(table.name, id);
        const lower = String(table.name || "").toLowerCase();
        if (lower && lower !== table.name) {
          tableIdByName.set(lower, id);
        }
        tableById.set(id, table);
      }

      const missingFkColumns = inferMissingForeignKeys(snapshot);

      function setStatus(text, isError) {
        if (!status) {
          return;
        }
        status.textContent = text || "";
        status.classList.toggle("error", Boolean(isError));
      }

      function sanitizeIdentifier(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          return "unnamed";
        }
        let result = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
        if (!/^[A-Za-z_]/.test(result)) {
          result = "_" + result;
        }
        return result;
      }

      function sanitizeType(value) {
        const trimmed = String(value || "").trim().toLowerCase();
        if (!trimmed) {
          return "string";
        }
        return trimmed.replace(/[^a-z0-9_]/g, "_");
      }

      function formatCount(value) {
        if (value === null || value === undefined) {
          return null;
        }
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) {
          return null;
        }
        if (numberValue >= 1000000000) {
          return (numberValue / 1000000000).toFixed(1).replace(/\\.0$/, "") + "b";
        }
        if (numberValue >= 1000000) {
          return (numberValue / 1000000).toFixed(1).replace(/\\.0$/, "") + "m";
        }
        if (numberValue >= 1000) {
          return (numberValue / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
        }
        return String(numberValue);
      }

      function inferMissingForeignKeys(data) {
        const tableNames = new Map();
        for (const table of data.tables || []) {
          const key = String(table.name || "").toLowerCase();
          if (key) {
            tableNames.set(key, table.name);
          }
        }
        const results = new Map();
        const suffixes = ["_id", "_uuid"];

        for (const table of data.tables || []) {
          const fkColumns = new Set();
          for (const fk of table.foreignKeys || []) {
            for (const column of fk.columns || []) {
              fkColumns.add(column);
            }
          }

          for (const column of table.columns || []) {
            if (fkColumns.has(column.name)) {
              continue;
            }
            const normalized = String(column.name || "").toLowerCase();
            let base = null;
            for (const suffix of suffixes) {
              if (normalized.endsWith(suffix)) {
                base = normalized.slice(0, -suffix.length);
                break;
              }
            }
            if (!base) {
              continue;
            }
            const target =
              tableNames.get(base) ||
              tableNames.get(base + "s") ||
              tableNames.get(base + "es") ||
              (base.endsWith("y") && tableNames.get(base.slice(0, -1) + "ies"));
            if (!target) {
              continue;
            }
            if (!results.has(table.name)) {
              results.set(table.name, new Set());
            }
            results.get(table.name).add(column.name);
          }
        }

        return results;
      }

      function isForeignKeyNullable(table, columns) {
        const columnMap = new Map();
        for (const column of table.columns || []) {
          columnMap.set(column.name, column.nullable);
        }
        return columns.some((column) => columnMap.get(column) !== false);
      }

      function isForeignKeyUnique(table, columns) {
        const normalized = new Set(columns || []);
        for (const index of table.indexes || []) {
          if (!index.unique && !index.primary) {
            continue;
          }
          const indexColumns = (index.columns || []).filter(Boolean);
          if (indexColumns.length !== normalized.size) {
            continue;
          }
          const allMatch = indexColumns.every((col) => normalized.has(col));
          if (allMatch) {
            return true;
          }
        }
        return false;
      }

      function resolveChildCardinality(nullable, unique) {
        if (unique) {
          return nullable ? "o|" : "||";
        }
        return nullable ? "o{" : "|{";
      }

      function buildMermaidSource(data, options) {
        const lines = ["erDiagram"];

        for (const table of data.tables || []) {
          const tableId = tableIdByName.get(table.name) || sanitizeIdentifier(table.name);
          lines.push("  " + tableId + " {");

          const pkColumns = new Set(table.primaryKey || []);
          const fkColumns = new Set();
          for (const fk of table.foreignKeys || []) {
            for (const column of fk.columns || []) {
              fkColumns.add(column);
            }
          }
          const missingColumns = options.highlightMissingFks
            ? missingFkColumns.get(table.name)
            : null;

          for (const column of table.columns || []) {
            let columnId = sanitizeIdentifier(column.name);
            if (missingColumns && missingColumns.has(column.name)) {
              columnId = columnId + MISSING_MARKER;
            }
            const type = sanitizeType(column.type);
            const tags = [];
            if (pkColumns.has(column.name)) {
              tags.push("PK");
            }
            if (fkColumns.has(column.name)) {
              tags.push("FK");
            }
            const tagSuffix = tags.length ? " " + tags.join(" ") : "";
            lines.push("    " + type + " " + columnId + tagSuffix);
          }

          if (options.showIndexes) {
            for (const index of table.indexes || []) {
              const indexName = sanitizeIdentifier(index.name || "idx");
              const meta = [];
              if (index.primary) {
                meta.push("PRIMARY");
              } else if (index.unique) {
                meta.push("UNIQUE");
              }
              if (index.method) {
                meta.push(index.method.toUpperCase());
              }
              const label = meta.length
                ? meta.join(" ") + " (" + (index.columns || []).join(", ") + ")"
                : (index.columns || []).join(", ");
              const comment = label ? " \\"" + label + "\\"" : "";
              lines.push("    INDEX " + indexName + comment);
            }
          }

          lines.push("  }");
        }

        for (const table of data.tables || []) {
          for (const fk of table.foreignKeys || []) {
            const parentTableName = fk.references?.table;
            if (!parentTableName) {
              continue;
            }
            const parentKey = String(parentTableName || "");
            const parentId =
              tableIdByName.get(parentKey) ||
              tableIdByName.get(parentKey.toLowerCase()) ||
              sanitizeIdentifier(parentKey);
            const childId =
              tableIdByName.get(table.name) ||
              tableIdByName.get(String(table.name || "").toLowerCase()) ||
              sanitizeIdentifier(table.name);
            if (!tableById.has(parentId)) {
              continue;
            }
            const nullable = isForeignKeyNullable(table, fk.columns || []);
            const unique = isForeignKeyUnique(table, fk.columns || []);
            const childCardinality = resolveChildCardinality(nullable, unique);
            const label = (fk.columns || []).join(", ");
            lines.push(
              "  " + parentId + " ||--" + childCardinality + " " + childId + " : \\"" + label + "\\""
            );
          }
        }

        return lines.join("\\n");
      }

      function applyTableLabels(svg) {
        if (!svg) {
          return;
        }
        for (const [tableId, table] of tableById.entries()) {
          const countLabel = state.showRowCounts ? formatCount(table.rowCount) : null;
          const label = countLabel ? table.name + " (" + countLabel + ")" : table.name;
          if (!label) {
            continue;
          }
          let updated = false;
          const groups = svg.querySelectorAll("g.entity");
          for (const group of groups) {
            const text = group.querySelector("text");
            if (text && text.textContent === tableId) {
              text.textContent = label;
              updated = true;
              break;
            }
          }
          if (updated) {
            continue;
          }
          const textNodes = svg.querySelectorAll("text");
          for (const node of textNodes) {
            if (node.textContent === tableId) {
              node.textContent = label;
              break;
            }
          }
        }
      }

      function applyMissingFkHighlight(svg) {
        if (!svg) {
          return;
        }
        const textNodes = svg.querySelectorAll("text");
        for (const node of textNodes) {
          const text = node.textContent || "";
          if (!text.includes(MISSING_MARKER)) {
            continue;
          }
          node.textContent = text.replace(MISSING_MARKER, "");
          node.style.fill = "var(--warning)";
          node.style.fontWeight = "600";
        }
      }

      function postProcessSvg(svg) {
        applyTableLabels(svg);
        if (state.highlightMissingFks) {
          applyMissingFkHighlight(svg);
        }
      }

      function initializeMermaid() {
        if (!window.mermaid) {
          setStatus("Mermaid failed to load.", true);
          return false;
        }
        const styles = getComputedStyle(document.documentElement);
        const background =
          styles.getPropertyValue("--vscode-editorWidget-background").trim() ||
          "#1f1f1f";
        const border =
          styles.getPropertyValue("--vscode-editorWidget-border").trim() || "#333";
        const foreground =
          styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";

        window.mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "strict",
          themeVariables: {
            primaryColor: background,
            primaryBorderColor: border,
            primaryTextColor: foreground,
            secondaryColor: background,
            tertiaryColor: background,
            lineColor: border,
          },
        });
        return true;
      }

      async function renderDiagram() {
        if (!diagram) {
          return;
        }
        const source = buildMermaidSource(snapshot, state);
        try {
          const result = await window.mermaid.render("erdDiagram", source);
          diagram.innerHTML = result.svg;
          if (typeof result.bindFunctions === "function") {
            result.bindFunctions(diagram);
          }
          const svg = diagram.querySelector("svg");
          postProcessSvg(svg);
          setStatus("");
          return source;
        } catch (err) {
          setStatus("Unable to render ER diagram.", true);
          diagram.innerHTML = "";
          return source;
        }
      }

      function handleToggle() {
        state.showIndexes = toggleIndexes ? toggleIndexes.checked : false;
        state.showRowCounts = toggleRowCounts ? toggleRowCounts.checked : false;
        state.highlightMissingFks = toggleMissingFks ? toggleMissingFks.checked : false;
        renderDiagram();
      }

      function decodeSvgToDataUrl(svg) {
        const serialized = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
        return URL.createObjectURL(blob);
      }

      function cloneSvgForExport(svg) {
        const clone = svg.cloneNode(true);
        const box = svg.getBBox();
        clone.setAttribute("width", String(Math.ceil(box.width)));
        clone.setAttribute("height", String(Math.ceil(box.height)));
        return clone;
      }

      async function exportDiagramPng() {
        const svg = diagram ? diagram.querySelector("svg") : null;
        if (!svg) {
          setStatus("No diagram available to export.", true);
          return;
        }
        const clonedSvg = cloneSvgForExport(svg);
        const url = decodeSvgToDataUrl(clonedSvg);
        const image = new Image();
        image.onload = () => {
          const ratio = window.devicePixelRatio || 1;
          const canvas = document.createElement("canvas");
          canvas.width = image.width * ratio;
          canvas.height = image.height * ratio;
          const context = canvas.getContext("2d");
          if (!context) {
            setStatus("Unable to access canvas context.", true);
            return;
          }
          context.scale(ratio, ratio);
          context.drawImage(image, 0, 0);
          canvas.toBlob((blob) => {
            if (!blob) {
              setStatus("Unable to export PNG.", true);
              return;
            }
            const reader = new FileReader();
            reader.onloadend = () => {
              vscode.postMessage({
                type: "exportPng",
                dataUrl: reader.result,
              });
            };
            reader.readAsDataURL(blob);
          }, "image/png");
        };
        image.onerror = () => {
          setStatus("Unable to render PNG.", true);
        };
        image.src = url;
      }

      function copyMermaidSource() {
        const source = buildMermaidSource(snapshot, {
          showIndexes: state.showIndexes,
          showRowCounts: false,
          highlightMissingFks: false,
        });
        vscode.postMessage({ type: "copyMermaid", text: source });
      }

      function openRecommendationsView() {
        vscode.postMessage({ type: "openRecommendations", schema: snapshot.schema });
      }

      if (toggleIndexes) {
        toggleIndexes.addEventListener("change", handleToggle);
      }
      if (toggleRowCounts) {
        toggleRowCounts.addEventListener("change", handleToggle);
      }
      if (toggleMissingFks) {
        toggleMissingFks.addEventListener("change", handleToggle);
      }
      if (exportPng) {
        exportPng.addEventListener("click", exportDiagramPng);
      }
      if (copyMermaid) {
        copyMermaid.addEventListener("click", copyMermaidSource);
      }
      if (openRecommendations) {
        openRecommendations.addEventListener("click", openRecommendationsView);
      }

      if (initializeMermaid()) {
        renderDiagram();
      }
    </script>
  </body>
</html>`;
}
