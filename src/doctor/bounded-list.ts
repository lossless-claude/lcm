/** Doctor runs over every store, test leftovers included; its lines stay readable. */
export const DOCTOR_LIST_LIMIT = 20;

export function doctorList<T>(items: T[], verbose: boolean, render: (item: T) => string): string[] {
  const shown = verbose ? items : items.slice(0, DOCTOR_LIST_LIMIT);
  const lines = shown.map(render);
  if (shown.length < items.length) {
    lines.push(`     … and ${items.length - shown.length} more`);
    lines.push("     Full details: lcm doctor --verbose");
  }
  return lines;
}

