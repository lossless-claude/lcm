import { workerRefusal } from "../worker-warning.js";
import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import { agentWorkerIdentity, createAgentWorkerTransport } from "../agent-worker-transport.js";
import { fail, readStdin, showHelpAndExit } from "./support.js";

export function registerAgentWorkerCommands(program: Command, deps: { createDaemonClientOrExit: () => Promise<DaemonClient> }): void {
  program.command("summarize-claim").description("Claim pool work in a declared dedicated worker session")
    .helpOption(false).option("-h, --help", "Show help")
    .action(async opts => {
      if (opts.help) await showHelpAndExit("summarize-claim");
      try {
        agentWorkerIdentity("cli", process.env, process.cwd());
        const worker = createAgentWorkerTransport(await deps.createDaemonClientOrExit(), "cli");
        console.log(JSON.stringify(await worker.claim(), null, 2));
      } catch (error) { fail(workerRefusal(error).message); }
    });
  program.command("summarize-submit [job-id]").description("Submit a claimed pool summary; reads summary text from stdin when --text is absent")
    .helpOption(false).option("-h, --help", "Show help")
    .option("--worker-id <id>", "Worker id returned by summarize-claim")
    .option("--model <model>", "Model that produced the summary")
    .option("--text <summary>", "Summary text (otherwise stdin)")
    .option("--error <message>", "Report a failed completion")
    .option("--usage <json>", "Optional input_tokens, output_tokens and estimated accounting")
    .action(async (jobId, opts) => {
      if (opts.help) await showHelpAndExit("summarize-submit");
      try {
        agentWorkerIdentity("cli", process.env, process.cwd());
        if (!jobId || !opts.workerId || !opts.model) throw new Error("job-id, --worker-id and --model are required");
        const text = opts.text ?? (opts.error === undefined ? await readStdin() : undefined);
        const worker = createAgentWorkerTransport(await deps.createDaemonClientOrExit(), "cli");
        console.log(JSON.stringify(await worker.submit({ jobId, workerId: opts.workerId, model: opts.model,
          text, error: opts.error, usage: opts.usage === undefined ? undefined : JSON.parse(opts.usage) }), null, 2));
      } catch (error) { fail((error as Error).message); }
    });
}
