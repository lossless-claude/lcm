import { describe, it, expect, vi } from "vitest";
import { handleDaemonStop, type DaemonStopDeps } from "../../src/commands/daemon-stop.js";
import { join } from "node:path";

const LC_DIR = "/home/user/.lossless-claude";
const PID_FILE = join(LC_DIR, "daemon.pid");

function makeDeps(overrides: Partial<DaemonStopDeps> = {}): DaemonStopDeps {
  return {
    existsSync: () => true,
    readFileSync: () => "12345" as any,
    unlinkSync: vi.fn(),
    spawnSync: () => ({ stdout: "node", status: 0 } as any),
    kill: vi.fn(),
    sleep: async () => {},
    ...overrides,
  };
}

describe("handleDaemonStop", () => {
  it("returns 'not running' when PID file is absent", async () => {
    const result = await handleDaemonStop(LC_DIR, makeDeps({ existsSync: () => false }));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("not running");
  });

  it("returns 'stale pid file' and unlinks when process is dead (ESRCH)", async () => {
    const unlink = vi.fn();
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === 0) { const e = Object.assign(new Error(), { code: "ESRCH" }); throw e; }
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("stale pid file");
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });

  it("sends SIGTERM and removes PID file after process stops", async () => {
    const unlink = vi.fn();
    let pollCount = 0;
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === 0) {
        pollCount++;
        if (pollCount > 1) { throw Object.assign(new Error(), { code: "ESRCH" }); }
      }
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe("lcm daemon stopped");
    // PID file removed AFTER process confirmed dead
    expect(unlink).toHaveBeenLastCalledWith(PID_FILE);
  });

  it("aborts with exit 1 when PID belongs to a non-lcm process", async () => {
    const kill = vi.fn(); // kill(0) always succeeds = process alive
    const result = await handleDaemonStop(
      LC_DIR,
      makeDeps({
        spawnSync: () => ({ stdout: "postgres", status: 0 } as any),
        kill,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("different process");
    expect(kill).not.toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("escalates to SIGKILL when process does not stop within poll limit", async () => {
    const unlink = vi.fn();
    let sigkillSent = false;
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === "SIGKILL") sigkillSent = true;
      if (sig === 0 && !sigkillSent) return; // still alive
      if (sig === 0 && sigkillSent) throw Object.assign(new Error(), { code: "ESRCH" });
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(kill).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(result.exitCode).toBe(0);
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });

  it("returns exit 0 with 'corrupt pid file' on unparseable content", async () => {
    const unlink = vi.fn();
    const result = await handleDaemonStop(
      LC_DIR,
      makeDeps({ readFileSync: () => "not-a-number" as any, unlinkSync: unlink }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("corrupt");
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });
});
