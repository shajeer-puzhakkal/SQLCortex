const SENSITIVE_TOKENS = ["user", "username", "uid", "database", "db", "dbname", "host", "hostname", "server"];

export function redactError(err: unknown): string {
  let message = "";
  if (typeof err === "string") {
    message = err;
  } else if (err instanceof Error && err.message) {
    message = err.message;
  } else {
    try {
      message = JSON.stringify(err);
    } catch {
      message = String(err);
    }
  }

  let redacted = message;
  redacted = redacted.replace(/\bpostgres(?:ql)?:\/\/[^\s)]+/gi, "postgresql://***");

  for (const token of SENSITIVE_TOKENS) {
    const keyValue = new RegExp(`\\b${token}\\s*=\\s*[^\\s;]+`, "gi");
    redacted = redacted.replace(keyValue, `${token}=***`);

    const quoted = new RegExp(`\\b${token}\\b\\s*["']([^"']+)["']`, "gi");
    redacted = redacted.replace(quoted, `${token} "***"`);
  }

  return redacted;
}
