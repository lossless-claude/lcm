import { exit, stdout } from "node:process";
import type { Command } from "commander";
import { readStdin } from "./support.js";

export function registerHookCommands(program: Command): void {
  program
    .command("codex-hook")
    .description("Dispatch a native Codex lifecycle hook")
    .action(async () => {
      const { dispatchCodexHook } = await import("../hooks/codex.js");
      const result = await dispatchCodexHook(await readStdin());
      if (result.stdout) stdout.write(result.stdout + "\n");
      exit(result.exitCode);
    });

  // ─── restore (hook) ────────────────────────────────────────────────────────
  program
    .command("restore")
    .description("Dispatch the restore hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("restore"); exit(0);
      }
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("restore", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-end (hook) ────────────────────────────────────────────────────
  program
    .command("session-end")
    .description("Dispatch the session-end hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("session-end"); exit(0);
      }
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("session-end", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── user-prompt (hook) ────────────────────────────────────────────────────
  program
    .command("user-prompt")
    .description("Dispatch the user-prompt hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("user-prompt"); exit(0);
      }
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("user-prompt", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── post-tool (hook) ──────────────────────────────────────────────────────
  program
    .command("post-tool")
    .description("Dispatch the post-tool hook (PostToolUse event)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("post-tool"); exit(0);
      }
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("post-tool", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-snapshot (hook) ─────────────────────────────────────────────
  program
    .command("session-snapshot")
    .description("Rolling ingest snapshot (called by Stop hook)")
    .helpOption(false)
    .action(async () => {
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("session-snapshot", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });
}
