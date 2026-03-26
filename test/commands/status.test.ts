import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any import of the module under test
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readFileSync } from "node:fs";
import { handleStatus } from "../../src/commands/status.js";

const LC_DIR = "/home/user/.lossless-claude";
const PORT = 3737;

describe("handleStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Authorization header when token file exists", async () => {
    vi.mocked(readFileSync).mockReturnValue("test-token-abc\n" as any);
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // health
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          daemon: { version: "0.7.0", uptime: 10, port: 3737 },
          project: { messageCount: 5, summaryCount: 1, promotedCount: 2 },
        }),
      });

    await handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR);

    const [_url, fetchOpts] = mockFetch.mock.calls[1];
    expect((fetchOpts.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-token-abc",
    );
  });

  it("does not crash when token file is missing (ENOENT)", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });
    mockFetch.mockResolvedValueOnce({ ok: false }); // health → daemon down

    await expect(
      handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR),
    ).resolves.toBeUndefined();
  });

  it("prints token-stale message on 401 without crashing", async () => {
    vi.mocked(readFileSync).mockReturnValue("old-token" as any);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // health ok
      .mockResolvedValueOnce({ ok: false, status: 401 }); // status → 401

    await handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("token stale"));
    spy.mockRestore();
  });

  it("--json outputs valid JSON with daemon and project fields", async () => {
    vi.mocked(readFileSync).mockReturnValue("tok" as any);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          daemon: { version: "0.7.0", uptime: 10, port: 3737 },
          project: { messageCount: 5, summaryCount: 1, promotedCount: 2 },
        }),
      });

    await handleStatus({ json: true, provider: "claude-process" }, PORT, LC_DIR);

    const written = (writeSpy.mock.calls[0][0] as string);
    const parsed = JSON.parse(written);
    expect(parsed.daemon.version).toBe("0.7.0");
    expect(parsed.project.messageCount).toBe(5);
    writeSpy.mockRestore();
  });
});
