/**
 * Sanitizes error messages for HTTP responses to prevent leaking
 * internal file paths, stack traces, or database schema details.
 */
export function sanitizeError(message: string): string {
  // Replace SQLite internal details with a generic message
  if (/SQLITE_/.test(message)) return "database constraint error";
  // Strip absolute file paths
  const sanitized = message.replace(/\/[\w/.\-@]+/g, "<path>");
  return sanitized;
}
