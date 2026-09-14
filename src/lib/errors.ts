/** Readable text for a thrown value. Falls back when `message` is missing or blank. */
export function errorText(reason: any): string {
  const message = reason?.message;
  if (typeof message === "string" && message.trim()) return message;

  const text = String(reason);
  return text === "[object Object]" || !text.trim() ? "Unknown error" : text;
}

/** HTTP status the api layer attached to a failed request, when there is one. */
export function errorStatus(reason: any): number | null {
  return typeof reason?.status === "number" ? reason.status : null;
}
