// Loaded into every Node process the suite runs: the vitest workers import it through
// `setup-env.ts`, and `setup-env.ts` adds it to NODE_OPTIONS, so every child those workers
// spawn with the inherited environment (the built CLI, a hook, a daemon that CLI spawns)
// loads it too.
//
// It refuses every TCP connection to, and every listen on, the ports named in
// LCM_TEST_GUARDED_PORTS — the compiled-in default daemon port. The developer's own daemon
// (and the CI runner's, which runs as the same user) listens there, and a test process
// resolves that port whenever it reads an lcm home with no config.json naming another one.
// Talking to that daemon writes into the developer's store; `ensureDaemon` and
// `stopDaemon` SIGTERM whatever answers /health there. Every pid either one signals comes
// from a /health answer on the port or from a pid file under the lcm home, so a refused
// port plus an isolated home leaves them nothing real to signal.
//
// A refusal behaves like a port nobody listens on, so the code under test degrades the way
// it would with no daemon, and is reported: a line on stderr, and a line in
// LCM_TEST_GUARD_DIR, which `setup-env.ts` turns into a failed test file.
//
// Plain JavaScript, not TypeScript: NODE_OPTIONS preloads it into processes that have no
// TypeScript loader.
import net from "node:net";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const INSTALLED = Symbol.for("lcm.test.portGuard");

function guardedPorts() {
  return new Set((process.env.LCM_TEST_GUARDED_PORTS ?? "")
    .split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0));
}

/** The port a connect/listen call targets, or undefined for a pipe or an unparseable call. */
function portOf(args) {
  let first = args[0];
  // net.connect hands Socket#connect its already-normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  const raw = first !== null && typeof first === "object" ? first.port : first;
  const port = Number(raw);
  return typeof raw !== "undefined" && raw !== null && raw !== "" && Number.isInteger(port) ? port : undefined;
}

function refuse(port, action, code) {
  const message = `[lcm test guard] refused to ${action} port ${port}, guarded by LCM_TEST_GUARDED_PORTS as the default lcm daemon port ` +
    `(pid ${process.pid}: ${process.argv.slice(1).join(" ")}). A test process resolved the real ` +
    "daemon's port: its lcm home has no config.json naming another one.";
  try { process.stderr.write(message + "\n"); } catch { /* stderr closed */ }
  const dir = process.env.LCM_TEST_GUARD_DIR;
  if (dir) {
    try { appendFileSync(join(dir, `violation.${process.pid}`), message + "\n"); } catch { /* dir removed */ }
  }
  return Object.assign(new Error(message), { code });
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const port = portOf(args);
    if (port !== undefined && guardedPorts().has(port)) {
      const error = refuse(port, "connect to", "ECONNREFUSED");
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };

  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    const port = portOf(args);
    if (port !== undefined && guardedPorts().has(port)) {
      const error = refuse(port, "listen on", "EADDRINUSE");
      process.nextTick(() => this.emit("error", error));
      return this;
    }
    return listen.apply(this, args);
  };
}
