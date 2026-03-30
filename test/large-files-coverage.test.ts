// test/large-files-coverage.test.ts
// Additional coverage for paths not exercised by large-files.test.ts:
//   - exploreStructuredData (CSV, TSV, XML, YAML, fallback)
//   - exploreCode directly
//   - formatFileReference edge cases (negative byteSize, missing fields)
//   - extractFileIdsFromContent edge cases
//   - parseFileBlocks edge cases (no blocks, start/end positions)
//   - extensionFromNameOrMime edge cases

import { describe, expect, it, vi } from "vitest";
import {
  exploreCode,
  exploreStructuredData,
  extensionFromNameOrMime,
  extractFileIdsFromContent,
  formatFileReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "../src/large-files.js";

// ---------------------------------------------------------------------------
// exploreStructuredData — CSV path
// ---------------------------------------------------------------------------
describe("exploreStructuredData — CSV", () => {
  it("summarises a basic CSV by extension", () => {
    const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA\nCharlie,35,SF";
    const result = exploreStructuredData(csv, undefined, "data.csv");
    expect(result).toContain("Structured summary (CSV)");
    expect(result).toContain("Rows: 3");
    expect(result).toContain("name");
    expect(result).toContain("age");
    expect(result).toContain("city");
  });

  it("summarises CSV by mime type", () => {
    const csv = "id,value\n1,foo\n2,bar";
    const result = exploreStructuredData(csv, "text/csv");
    expect(result).toContain("Structured summary (CSV)");
    expect(result).toContain("Rows: 2");
    expect(result).toContain("Columns (2)");
  });

  it("handles empty CSV content", () => {
    const result = exploreStructuredData("", "text/csv");
    expect(result).toContain("no rows found");
  });

  it("handles CSV with header only (no data rows)", () => {
    const csv = "col1,col2,col3";
    const result = exploreStructuredData(csv, "text/csv");
    expect(result).toContain("Rows: 0");
    expect(result).toContain("no data rows");
  });
});

// ---------------------------------------------------------------------------
// exploreStructuredData — TSV path
// ---------------------------------------------------------------------------
describe("exploreStructuredData — TSV", () => {
  it("summarises a TSV file by extension", () => {
    const tsv = "name\tvalue\nfoo\t1\nbar\t2";
    const result = exploreStructuredData(tsv, undefined, "report.tsv");
    expect(result).toContain("Structured summary (TSV)");
    expect(result).toContain("Rows: 2");
    expect(result).toContain("name");
  });

  it("summarises TSV by mime type", () => {
    const tsv = "a\tb\tc\n1\t2\t3";
    const result = exploreStructuredData(tsv, "text/tab-separated-values");
    expect(result).toContain("Structured summary (TSV)");
    expect(result).toContain("Columns (3)");
  });
});

// ---------------------------------------------------------------------------
// exploreStructuredData — XML path
// ---------------------------------------------------------------------------
describe("exploreStructuredData — XML", () => {
  it("summarises XML by extension", () => {
    const xml =
      "<root><items><item id='1'>Hello</item><item id='2'>World</item></items></root>";
    const result = exploreStructuredData(xml, undefined, "data.xml");
    expect(result).toContain("Structured summary (XML)");
    expect(result).toContain("Root element: root");
    expect(result).toContain("items");
  });

  it("summarises XML by mime type text/xml", () => {
    const xml = "<catalog><book title='Test'/></catalog>";
    const result = exploreStructuredData(xml, "text/xml");
    expect(result).toContain("Root element: catalog");
    expect(result).toContain("book");
  });

  it("summarises XML by mime type application/xml", () => {
    const xml = "<feed><entry/></feed>";
    const result = exploreStructuredData(xml, "application/xml");
    expect(result).toContain("Structured summary (XML)");
    expect(result).toContain("Root element: feed");
  });
});

// ---------------------------------------------------------------------------
// exploreStructuredData — YAML path
// ---------------------------------------------------------------------------
describe("exploreStructuredData — YAML", () => {
  it("summarises YAML by extension — detects block-mapping keys", () => {
    // exploreYaml only picks up keys that have NO value on the same line
    // (block mappings like `dependencies:` with children on next lines)
    const yaml = "dependencies:\n  - lodash\n  - express\nscripts:\n  build: tsc\n";
    const result = exploreStructuredData(yaml, undefined, "config.yaml");
    expect(result).toContain("Structured summary (YAML)");
    expect(result).toContain("dependencies");
    expect(result).toContain("scripts");
  });

  it("summarises YAML by .yml extension — reports none detected for inline values", () => {
    // Lines like "host: localhost" don't match the block-key regex — result is (none detected)
    const yaml = "host: localhost\nport: 8080\n";
    const result = exploreStructuredData(yaml, undefined, "settings.yml");
    expect(result).toContain("Structured summary (YAML)");
    expect(result).toContain("Top-level keys (0)");
    expect(result).toContain("(none detected)");
  });

  it("summarises YAML by mime type", () => {
    const yaml = "key: value\n";
    const result = exploreStructuredData(yaml, "application/yaml");
    expect(result).toContain("Structured summary (YAML)");
  });
});

// ---------------------------------------------------------------------------
// exploreStructuredData — JSON error path
// ---------------------------------------------------------------------------
describe("exploreStructuredData — JSON error path", () => {
  it("returns parse error message for invalid JSON", () => {
    const result = exploreStructuredData("{not valid json}", "application/json");
    expect(result).toContain("failed to parse as valid JSON");
  });
});

// ---------------------------------------------------------------------------
// exploreStructuredData — generic fallback
// ---------------------------------------------------------------------------
describe("exploreStructuredData — generic fallback", () => {
  it("returns character/line count for unknown type", () => {
    const content = "some unknown content\nwith two lines";
    const result = exploreStructuredData(content, "application/octet-stream");
    expect(result).toContain("Structured summary:");
    expect(result).toContain("Characters:");
    expect(result).toContain("Lines:");
  });
});

// ---------------------------------------------------------------------------
// exploreCode directly
// ---------------------------------------------------------------------------
describe("exploreCode", () => {
  it("includes filename when provided", () => {
    const code = "import { x } from 'y';\nexport function foo() {}";
    const result = exploreCode(code, "util.ts");
    expect(result).toContain("Code exploration summary (util.ts)");
  });

  it("omits filename when not provided", () => {
    const code = "const x = 1;";
    const result = exploreCode(code);
    expect(result).toContain("Code exploration summary:");
    expect(result).not.toContain("undefined");
  });

  it("extracts imports from require() syntax", () => {
    const code = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "module.exports = {};",
    ].join("\n");
    const result = exploreCode(code, "util.js");
    expect(result).toContain("Imports/dependencies");
    expect(result).toContain("require(");
  });

  it("counts lines accurately", () => {
    const code = "line1\nline2\nline3\nline4\nline5";
    const result = exploreCode(code);
    expect(result).toContain("Lines: 5");
  });

  it("reports no imports when there are none", () => {
    const code = "const x = 42;\nconsole.log(x);";
    const result = exploreCode(code);
    expect(result).toContain("none detected");
  });
});

// ---------------------------------------------------------------------------
// formatFileReference edge cases
// ---------------------------------------------------------------------------
describe("formatFileReference — edge cases", () => {
  it("clamps negative byteSize to zero", () => {
    const result = formatFileReference({
      fileId: "file_aaaaaaaaaaaaaaaa",
      fileName: "test.txt",
      mimeType: "text/plain",
      byteSize: -100,
      summary: "summary",
    });
    expect(result).toContain("0 bytes");
  });

  it("uses 'unknown' when fileName is empty string", () => {
    const result = formatFileReference({
      fileId: "file_aaaaaaaaaaaaaaaa",
      fileName: "",
      mimeType: "text/plain",
      byteSize: 1024,
      summary: "summary",
    });
    expect(result).toContain("| unknown |");
  });

  it("uses 'unknown' when mimeType is empty string", () => {
    const result = formatFileReference({
      fileId: "file_aaaaaaaaaaaaaaaa",
      fileName: "file.txt",
      mimeType: "",
      byteSize: 512,
      summary: "summary",
    });
    // mime is empty → falls back to "unknown"
    expect(result).toContain("| unknown |");
  });

  it("falls back to '(no summary available)' for empty summary", () => {
    const result = formatFileReference({
      fileId: "file_aaaaaaaaaaaaaaaa",
      fileName: "file.txt",
      mimeType: "text/plain",
      byteSize: 100,
      summary: "",
    });
    expect(result).toContain("(no summary available)");
  });
});

// ---------------------------------------------------------------------------
// extractFileIdsFromContent edge cases
// ---------------------------------------------------------------------------
describe("extractFileIdsFromContent — edge cases", () => {
  it("returns empty array for content with no file ids", () => {
    expect(extractFileIdsFromContent("no ids here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractFileIdsFromContent("")).toEqual([]);
  });

  it("normalises file ids to lowercase", () => {
    // FILE_ID_RE uses case-insensitive flag but ids are always hex so this is
    // effectively a pass-through; test that output is lowercase
    const ids = extractFileIdsFromContent("ref file_AABBCCDDEEFF0011 end");
    expect(ids).toEqual(["file_aabbccddeeff0011"]);
  });
});

// ---------------------------------------------------------------------------
// parseFileBlocks edge cases
// ---------------------------------------------------------------------------
describe("parseFileBlocks — edge cases", () => {
  it("returns empty array when no file blocks exist", () => {
    expect(parseFileBlocks("no blocks here")).toEqual([]);
  });

  it("records correct start and end byte offsets", () => {
    const prefix = "prefix ";
    const tag = '<file name="a.txt">hello</file>';
    const blocks = parseFileBlocks(prefix + tag);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(prefix.length);
    expect(blocks[0].end).toBe(prefix.length + tag.length);
  });

  it("parses attributes with unquoted values", () => {
    const blocks = parseFileBlocks("<file name=notes.txt>content</file>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fileName).toBe("notes.txt");
  });

  it("stores all parsed attributes on the attributes map", () => {
    const blocks = parseFileBlocks('<file name="f.csv" mime="text/csv" size="42">data</file>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].attributes).toMatchObject({
      name: "f.csv",
      mime: "text/csv",
      size: "42",
    });
  });
});

// ---------------------------------------------------------------------------
// extensionFromNameOrMime edge cases
// ---------------------------------------------------------------------------
describe("extensionFromNameOrMime — edge cases", () => {
  it("prefers fileName extension over mime type", () => {
    // File says .ts but mime says json — name wins
    expect(extensionFromNameOrMime("script.ts", "application/json")).toBe("ts");
  });

  it("falls back to mime when fileName has no extension", () => {
    expect(extensionFromNameOrMime("Makefile", "application/json")).toBe("json");
  });

  it("returns txt as final fallback", () => {
    expect(extensionFromNameOrMime(undefined, "application/octet-stream")).toBe("txt");
  });

  it("handles path separators in fileName (extracts basename)", () => {
    expect(extensionFromNameOrMime("some/path/to/file.py")).toBe("py");
  });
});

// ---------------------------------------------------------------------------
// generateExplorationSummary — routing for CSV / TSV / XML / YAML
// ---------------------------------------------------------------------------
describe("generateExplorationSummary — structured types via filename", () => {
  it("routes CSV to structured summary", async () => {
    const result = await generateExplorationSummary({
      content: "a,b\n1,2",
      fileName: "data.csv",
    });
    expect(result).toContain("Structured summary (CSV)");
  });

  it("routes TSV to structured summary", async () => {
    const result = await generateExplorationSummary({
      content: "a\tb\n1\t2",
      fileName: "data.tsv",
    });
    expect(result).toContain("Structured summary (TSV)");
  });

  it("routes XML to structured summary", async () => {
    const result = await generateExplorationSummary({
      content: "<root><item/></root>",
      fileName: "data.xml",
    });
    expect(result).toContain("Structured summary (XML)");
  });

  it("routes YAML to structured summary", async () => {
    const result = await generateExplorationSummary({
      content: "key: value\n",
      fileName: "config.yaml",
    });
    expect(result).toContain("Structured summary (YAML)");
  });

  it("falls back to deterministic text summary when summarizeText returns null", async () => {
    const summarizeText = vi.fn(async () => null);
    const result = await generateExplorationSummary({
      content: "plain text content without any structure",
      fileName: "notes.txt",
      summarizeText,
    });
    expect(summarizeText).toHaveBeenCalledTimes(1);
    expect(result).toContain("Text exploration summary");
  });

  it("falls back to deterministic text summary when summarizeText returns empty string", async () => {
    const summarizeText = vi.fn(async () => "  ");
    const result = await generateExplorationSummary({
      content: "some content",
      fileName: "notes.txt",
      summarizeText,
    });
    expect(result).toContain("Text exploration summary");
  });
});
