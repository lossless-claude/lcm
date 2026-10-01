/** Shared by passive promotion and the legacy promoted-tag backfill. */
export function passiveTypeTag(category: string): string {
  switch (category) {
    case "decision": return "type:preference";
    case "error": return "type:gotcha";
    case "plan": return "type:decision";
    case "role":
    case "context": return "type:user-context";
    case "env": return "type:environment";
    case "git":
    case "intent":
    case "task":
    case "security": return "type:workflow";
    default: return "type:pattern";
  }
}
