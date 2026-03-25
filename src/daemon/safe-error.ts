/**
 * Sanitizes error messages for HTTP responses to prevent leaking
 * internal file paths, stack traces, or database schema details.
 */
export function sanitizeError(message: string): string {
  // Replace SQLite internal details with a generic message
  if (/SQLITE_/.test(message)) return "database constraint error";
  // Strip POSIX absolute file paths
  let sanitized = message.replace(/\/[\w/.\-@]+/g, "<path>");
  // Strip Windows absolute file paths (e.g. C:\Users\... or D:\foo\bar)
  sanitized = sanitized.replace(/[A-Za-z]:\\[\w\\.\-@]*/g, "<path>");
  return sanitized;
}
