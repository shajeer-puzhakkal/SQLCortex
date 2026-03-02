export type ActiveStatement = {
  sql: string;
  start: number;
  end: number;
};

type StatementBoundary = {
  start: number;
  end: number;
};

function clampOffset(cursorOffset: number, textLength: number): number {
  if (!Number.isFinite(cursorOffset)) {
    return 0;
  }

  const rounded = Math.trunc(cursorOffset);
  return Math.max(0, Math.min(textLength, rounded));
}

function readDollarQuoteDelimiter(text: string, start: number): string | null {
  if (text[start] !== "$") {
    return null;
  }

  let index = start + 1;

  while (index < text.length && /[A-Za-z0-9_]/.test(text[index]!)) {
    index += 1;
  }

  if (index >= text.length || text[index] !== "$") {
    return null;
  }

  return text.slice(start, index + 1);
}

function skipLineComment(text: string, start: number): number {
  let index = start + 2;

  while (index < text.length && text[index] !== "\n") {
    index += 1;
  }

  return index;
}

function skipBlockComment(text: string, start: number): number {
  let depth = 1;
  let index = start + 2;

  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];

    if (current === "/" && next === "*") {
      depth += 1;
      index += 2;
      continue;
    }

    if (current === "*" && next === "/") {
      depth -= 1;
      index += 2;

      if (depth === 0) {
        return index;
      }

      continue;
    }

    index += 1;
  }

  return text.length;
}

function skipQuotedLiteral(text: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;

  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index += 1;
  }

  return text.length;
}

function skipDollarQuotedLiteral(text: string, start: number, delimiter: string): number {
  const closeIndex = text.indexOf(delimiter, start + delimiter.length);

  if (closeIndex === -1) {
    return text.length;
  }

  return closeIndex + delimiter.length;
}

function splitStatementBoundaries(documentText: string): StatementBoundary[] {
  const boundaries: StatementBoundary[] = [];
  let start = 0;
  let index = 0;

  while (index < documentText.length) {
    const current = documentText[index];
    const next = documentText[index + 1];

    if (current === "-" && next === "-") {
      index = skipLineComment(documentText, index);
      continue;
    }

    if (current === "/" && next === "*") {
      index = skipBlockComment(documentText, index);
      continue;
    }

    if (current === "'") {
      index = skipQuotedLiteral(documentText, index, "'");
      continue;
    }

    if (current === '"') {
      index = skipQuotedLiteral(documentText, index, '"');
      continue;
    }

    if (current === "$") {
      const delimiter = readDollarQuoteDelimiter(documentText, index);

      if (delimiter) {
        index = skipDollarQuotedLiteral(documentText, index, delimiter);
        continue;
      }
    }

    if (current === ";") {
      boundaries.push({ start, end: index });
      start = index + 1;
    }

    index += 1;
  }

  boundaries.push({ start, end: documentText.length });

  return boundaries;
}

function trimBoundary(documentText: string, boundary: StatementBoundary): ActiveStatement {
  let start = boundary.start;
  let end = boundary.end;

  while (start < end && /\s/.test(documentText[start]!)) {
    start += 1;
  }

  while (end > start && /\s/.test(documentText[end - 1]!)) {
    end -= 1;
  }

  return {
    sql: documentText.slice(start, end),
    start,
    end,
  };
}

export function getActiveStatement(documentText: string, cursorOffset: number): ActiveStatement {
  const normalizedText = documentText.replace(/\r\n/g, "\n");

  if (normalizedText.length === 0) {
    return { sql: "", start: 0, end: 0 };
  }

  const boundaries = splitStatementBoundaries(normalizedText);
  let anchor = clampOffset(cursorOffset, normalizedText.length);

  if (anchor === normalizedText.length && anchor > 0) {
    anchor -= 1;
  }

  if (normalizedText[anchor] === ";" && anchor > 0) {
    anchor -= 1;
  }

  const boundary =
    boundaries.find((candidate) => anchor >= candidate.start && anchor < candidate.end) ??
    boundaries[boundaries.length - 1]!;

  return trimBoundary(normalizedText, boundary);
}
