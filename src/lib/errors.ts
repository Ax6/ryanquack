/** Readable text for a thrown value. Falls back when `message` is missing or blank. */
export function errorText(reason: unknown): string {
  const message = (reason as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.trim()) return message;

  const text = String(reason);
  return text === "[object Object]" || !text.trim() ? "Unknown error" : text;
}

/** HTTP status the api layer attached to a failed request, when there is one. */
export function errorStatus(reason: unknown): number | null {
  const status = (reason as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : null;
}
