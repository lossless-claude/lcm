import safeRegex from "safe-regex";

export function validateRegex(pattern: string): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : "syntax error"}`);
  }
  let safe: boolean;
  try {
    safe = safeRegex(pattern);
  } catch {
    safe = false;
  }
  if (!safe) {
    throw new Error(`Unsafe regex pattern rejected (potential catastrophic backtracking): ${pattern}`);
  }
  return re;
}
