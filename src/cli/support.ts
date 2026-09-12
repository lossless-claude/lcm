import { exit } from "node:process";

export function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid ${optionName}: ${value}`);
    exit(1);
  }
  return parsed;
}
