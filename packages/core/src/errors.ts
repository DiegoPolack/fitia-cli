// Hybrid of cligentic's error-map pattern. Never forward raw provider text.
export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint: string,
    public exitCode = 2,
  ) {
    super(message);
  }
}

export function invalidResponse(): never {
  throw new CliError(
    "INVALID_RESPONSE",
    "Fitia returned an unexpected response.",
    "The unofficial API may have changed. Check the current product documentation before retrying.",
    4,
  );
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") invalidResponse();
  return value;
}

export function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) invalidResponse();
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidResponse();
  return value;
}

export function safeText(value: unknown): string {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
