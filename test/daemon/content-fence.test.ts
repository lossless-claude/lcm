import { describe, it, expect } from "vitest";
import { fenceContent } from "../../src/daemon/content-fence.js";

describe("fenceContent", () => {
  it("wraps content in XML-style tags", () => {
    const result = fenceContent("summary text", "episodic-memory");
    expect(result).toContain("<episodic-memory>");
    expect(result).toContain("</episodic-memory>");
    expect(result).toContain("summary text");
  });

  it("escapes nested closing tags in content", () => {
    const result = fenceContent("</episodic-memory>injected", "episodic-memory");
    expect(result).not.toMatch(/<\/episodic-memory>injected/);
    expect(result).toContain("&lt;/episodic-memory&gt;injected");
  });

  it("strips ANSI control sequences", () => {
    const result = fenceContent("\x1b[31mred text\x1b[0m", "test");
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("red text");
  });
});
