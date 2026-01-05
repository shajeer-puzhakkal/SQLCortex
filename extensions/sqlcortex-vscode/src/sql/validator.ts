export type SqlValidationResult = { ok: true } | { ok: false; reason: string };

const ALLOWED_START_KEYWORDS = ["select", "with", "explain"] as const;
const BLOCKED_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
] as const;

export function validateReadOnlySql(sql: string): SqlValidationResult {
  const cleaned = stripCommentsAndStrings(sql);
  const normalized = cleaned.trim();
  if (!normalized) {
    return { ok: false, reason: "SQL is empty." };
  }

  const blockedKeyword = matchBlockedKeyword(cleaned);
  if (blockedKeyword) {
    return {
      ok: false,
      reason: `Write query blocked: "${blockedKeyword.toUpperCase()}" is not allowed.`,
    };
  }

  const firstKeyword = extractFirstKeyword(normalized);
  if (!firstKeyword) {
    return { ok: false, reason: "No SQL statement found." };
  }

  const normalizedKeyword = firstKeyword.toLowerCase();
  if (!ALLOWED_START_KEYWORDS.includes(normalizedKeyword as (typeof ALLOWED_START_KEYWORDS)[number])) {
    return {
      ok: false,
      reason: `Only SELECT, WITH, or EXPLAIN statements are allowed. Found "${firstKeyword.toUpperCase()}".`,
    };
  }

  return { ok: true };
}

function extractFirstKeyword(sql: string): string | null {
  const match = sql.match(/\b([a-zA-Z]+)\b/);
  return match ? match[1] : null;
}

function matchBlockedKeyword(sql: string): string | null {
  const pattern = new RegExp(`\\b(${BLOCKED_KEYWORDS.join("|")})\\b`, "i");
  const match = sql.match(pattern);
  return match ? match[1] : null;
}

function stripCommentsAndStrings(input: string): string {
  let output = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += "\n";
      } else {
        output += " ";
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        output += "  ";
        i += 2;
      } else {
        output += " ";
        i += 1;
      }
      continue;
    }

    if (inSingle) {
      if (char === "'") {
        if (next === "'") {
          output += "  ";
          i += 2;
        } else {
          inSingle = false;
          output += " ";
          i += 1;
        }
      } else {
        output += " ";
        i += 1;
      }
      continue;
    }

    if (inDouble) {
      if (char === "\"") {
        if (next === "\"") {
          output += "  ";
          i += 2;
        } else {
          inDouble = false;
          output += " ";
          i += 1;
        }
      } else {
        output += " ";
        i += 1;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      output += "  ";
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      output += "  ";
      i += 2;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      output += " ";
      i += 1;
      continue;
    }

    if (char === "\"") {
      inDouble = true;
      output += " ";
      i += 1;
      continue;
    }

    output += char;
    i += 1;
  }

  return output;
}
