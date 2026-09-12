import { exit, stdin } from "node:process";
import type { Command } from "commander";

/**
 * True when `--help` was asked for on this command or on the parent it hangs from.
 *
 * Commander routes a flag declared on both a parent and its subcommand to the
 * parent's options, so a subcommand that only reads its own would never see it:
 * `lcm daemon stop --help` ran the action and stopped the daemon. Both command
 * trees that carry a hand-rolled help option — `daemon` and `connectors` —
 * declare it on the parent as well, so both need the parent consulted.
 */
export function helpRequested(parent: Command, opts: { help?: boolean }): boolean {
  return Boolean(opts.help || (parent.opts() as { help?: boolean }).help);
}

export function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid ${optionName}: ${value}`);
    exit(1);
  }
  return parsed;
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, 5000);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    });
  });
}
