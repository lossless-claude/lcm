import { describe, expect, it } from "vitest";
import { compareStoredMessageContent, isTokenadeFold } from "../src/message-content.js";

const scrubKeys = (text: string) => text.replace(/sk-\w+/g, "[REDACTED]");

describe("compareStoredMessageContent", () => {
  it("classifies a row cut at the NUL as cut even when the redaction marker could absorb the rest", () => {
    // The stored row holds only what preceded the NUL, already redacted.
    expect(compareStoredMessageContent("[REDACTED]", "sk-abc\u0000tail", scrubKeys)).toBe("cut");
  });

  it("matches a whole row stored with the NUL normalized", () => {
    expect(compareStoredMessageContent("[REDACTED]�tail", "sk-abc\u0000tail", scrubKeys)).toBe("full");
  });

  it("keeps the removed-pattern allowance for text without a NUL", () => {
    expect(compareStoredMessageContent("token [REDACTED] end", "token abc123 end", (text) => text)).toBe("full");
  });
});


describe("compareStoredMessageContent with tokenade's cold-resume placeholders", () => {
  const identity = (text: string) => text;
  const fold = (tokens: number, stash: string | null = "0123456789ab") =>
    `[tokenade:elided ${tokens} tokens on cold resume — recover: ${stash === null ? "(original not stashed)" : `tokenade expand-ref ${stash}`}]`;
  /** Ordinary text of about `tokens` tokens, four characters each. */
  const output = (tokens: number, word = "log") => `${word} `.repeat(tokens).trimEnd();
  /** A row the parser found folded. */
  const compare = (stored: string, current: string, scrub: (text: string) => string) =>
    compareStoredMessageContent(stored, current, scrub, true);

  it("matches a stored tool output tokenade folded whole", () => {
    expect(compare(output(400), fold(400), identity)).toBe("elided");
  });

  it("tries no placeholder in a row the parser did not find folded", () => {
    expect(compareStoredMessageContent(output(400), fold(400), identity)).toBeUndefined();
    expect(compareStoredMessageContent(`tokenade writes:\n${output(40)}`, `tokenade writes:\n${fold(40)}`, identity)).toBeUndefined();
  });

  it("refuses a stored row too short for what the placeholder reports hiding", () => {
    expect(compare("Bash", fold(400), identity)).toBeUndefined();
    expect(compare(output(400).slice(0, 99), fold(400), identity)).toBeUndefined();
    expect(compare(output(400).slice(0, 100), fold(400), identity)).toBe("elided");
  });

  it("lets a redaction in the stored row stand for what the placeholder hid, but not one before it", () => {
    // A private key Read whole: tokens count the key, the stored row holds the marker.
    expect(compare("     1\t[REDACTED]", fold(1000), identity)).toBe("elided");
    expect(compare("[REDACTED] head\nshort", `[REDACTED] head\n${fold(1000)}`, identity)).toBeUndefined();
  });

  it("lets a redaction stand for one secret's worth of what the placeholder hid, not any amount", () => {
    // An 8192-bit key Read whole, at the densest 1.3 characters a token.
    expect(compare("     1\t[REDACTED]", fold(5000), identity)).toBe("elided");
    // A short config row is not what hid a 48 KB build log, whatever it redacts.
    expect(compare("DB_HOST=db.internal\n[REDACTED]", fold(12000), identity)).toBeUndefined();
  });

  it("starts the value after a fold on a line of its own", () => {
    expect(compare(`${output(400)}\nok`, `${fold(400)}\nok`, identity)).toBe("elided");
    expect(compare(`${output(400)}\nnot ok`, `${fold(400)}\nok`, identity)).toBeUndefined();
    expect(compare(`${output(100)}\ndone\n${output(100)}`, `${fold(100)}\ndone\n${fold(100)}`, identity)).toBe("elided");
    expect(compare(`${output(100)}undone${output(100)}`, `${fold(100)}\ndone\n${fold(100)}`, identity)).toBeUndefined();
  });

  it("matches a delegated report whose opening tokenade kept, cut at a line or mid-line", () => {
    expect(compare(`Verdict: ok\n${output(400)}`, `Verdict: ok\n${fold(400)}`, identity)).toBe("elided");
    // Without a newline inside its window tokenade cuts mid-line and adds the newline itself.
    expect(compare(`Verdict: ok and ${output(400)}`, `Verdict: ok and\n${fold(400)}`, identity)).toBe("elided");
  });

  it("matches an output tokenade could not stash, and several folds in one row in order", () => {
    expect(compare(output(400), fold(400, null), identity)).toBe("elided");
    const stored = `${output(400, "one")}\n[tool error]\nExit code 1\n${output(400, "two")}`;
    expect(compare(stored, `${fold(400)}\n[tool error]\n${fold(400, "ab")}`, identity)).toBe("elided");
  });

  it("refuses text that differs outside the folded spans, or folds out of order", () => {
    expect(compare(`A\n${output(40)}\nB`, `A\n${fold(40)}\nC`, identity)).toBeUndefined();
    expect(compare(`X\n${output(40)}\nB`, `A\n${fold(40)}\nB`, identity)).toBeUndefined();
    expect(compare("A\none\nC\ntwo\nB", `A\n${fold(4)}\nB\n${fold(4)}\nC`, identity)).toBeUndefined();
  });

  it("keeps a redaction pattern from rewriting the placeholder", () => {
    const scrubHex = (text: string) => text.replace(/\b[0-9a-f]{12}\b/g, "[REDACTED]");
    expect(compare(output(400), fold(400), scrubHex)).toBe("elided");
  });

  it("scrubs the newline before a placeholder with the line it ends", () => {
    const scrubLine = (text: string) => text.replace(/SECRET=.*/g, "SECRET=[REDACTED]");
    expect(compare(`run\nSECRET=abc\n${output(400)}`, `run\nSECRET=abc\n${fold(400)}`, scrubLine)).toBe("elided");
  });

  it("anchors the next value where a redaction ending the folded output took the separator", () => {
    // A commit hash closing a Task report is redacted with the whitespace after it.
    const scrubSha = (text: string) => text.replace(/\b[0-9a-f]{40}\s/g, "[REDACTED]");
    const stored = `${output(400)}\nCommit: ${"a".repeat(40)}\nagentId: x1`;
    expect(compare(stored, `${fold(400)}\nagentId: x1`, scrubSha)).toBe("elided");
    expect(compare(`${stored}\n${output(400)}`, `${fold(400)}\nagentId: x1\n${fold(400, "ab")}`, scrubSha)).toBe("elided");
  });

  it("stands in for the placeholder with a character the text does not hold", () => {
    expect(compare(` prompt\n${output(400)}`, ` prompt\n${fold(400)}`, identity)).toBe("elided");
  });

  it("matches tokenade's own large-output notice folded under the size and stash it names, and only that notice", () => {
    const notice = (tokens: number, stash: string) =>
      `[tokenade: this blob is ~${tokens} tokens — too large to dump whole. recover with \`tokenade expand-ref ${stash}\` · \`--grep <pat>\` exact lines.]\n`;
    expect(compare(notice(8466, "0256646c013b"), fold(8466, "0256646c013b"), identity)).toBe("elided");
    expect(compare(notice(8466, "0256646c013b"), fold(8466, "0256646c013c"), identity)).toBeUndefined();
    expect(compare(notice(8000, "0256646c013b"), fold(8466, "0256646c013b"), identity)).toBeUndefined();
    // Another row naming the stash, or a notice outside the hidden span, is not what was folded.
    expect(compare("restored 1 of 1: tokenade expand-ref 0256646c013b", fold(8466, "0256646c013b"), identity)).toBeUndefined();
    const tail = notice(8466, "0256646c013b");
    expect(compare(`x\n${tail}`, `${fold(8466, "0256646c013b")}\n${tail}`, identity)).toBeUndefined();
    // The notice must start the hidden span, and name the stash itself.
    expect(compare(`${"x".repeat(300)} ${tail}`, fold(8466, "0256646c013b"), identity)).toBeUndefined();
    expect(compare(`${notice(8466, "aaaaaaaaaaaa")}${tail}`, fold(8466, "0256646c013b"), identity)).toBeUndefined();
    expect(compare(`${notice(8466, "aaaaaaaaaaaa")}later: tokenade expand-ref 0256646c013b`, fold(8466, "0256646c013b"), identity)).toBeUndefined();
  });

  it("lets no stored redaction stand for a placeholder outside the elision match", () => {
    expect(compare("[REDACTED]", fold(200000), identity)).toBeUndefined();
    expect(compare("DB_HOST=db.internal\n[REDACTED]", `DB_HOST=db.internal\n${fold(200000)}`, identity)).toBeUndefined();
    expect(compare("[REDACTED]agentId: x1", `${fold(200000)}\nagentId: x1`, identity)).toBeUndefined();
  });

  it("holds a middle hidden span to the size its placeholder reports, less its redactions' share", () => {
    const current = `${fold(1000)}\ndone\n${fold(100)}`;
    expect(compare(`x\ndone\n${output(100)}`, current, identity)).toBeUndefined();
    expect(compare(`${output(250)}\ndone\n${output(100)}`, current, identity)).toBe("elided");
    expect(compare(`x [REDACTED]\ndone\n${output(100)}`, current, identity)).toBe("elided");
  });

  it("lets every redaction in a span count, but none past where the span may end", () => {
    // Two keys in one folded output: each marker stands for its own secret.
    expect(compare(`[REDACTED]\n${"x".repeat(990)}\n[REDACTED]`, fold(16000), identity)).toBe("elided");
    // The second marker lies in the next span, past where the first one let this span end.
    const stored = `[REDACTED]${"y".repeat(490)}\nmid\n${"z".repeat(495)}[REDACTED]${"z".repeat(100)}`;
    expect(compare(stored, `${fold(8000)}\nmid\n${fold(400)}`, identity)).toBe("elided");
  });

  it("sizes one redaction's share of a hidden span at 1576 characters", () => {
    const stored = `[REDACTED]${"x".repeat(90)}`;
    expect(compare(stored, fold(6704), identity)).toBe("elided");
    expect(compare(stored, fold(6708), identity)).toBeUndefined();
  });

  it("places a value after a fold where a redaction ending the span took its newline", () => {
    const current = `${fold(4000)}\nmid\n${fold(400)}`;
    // The marker that lowered the span's minimum to its own end also took the newline.
    expect(compare(`${"x".repeat(500)}[REDACTED]mid\n${"z".repeat(150)}`, current, identity)).toBe("elided");
    // Of the two places the value appears, the earlier one leaves the next span its length.
    expect(compare(`${"x".repeat(500)}[REDACTED]mid\n${"z".repeat(150)}\nmid${"z".repeat(50)}`, current, identity)).toBe("elided");
    expect(compare(`${"x".repeat(1000)}\nmid\n${"z".repeat(150)}[REDACTED]mid${"z".repeat(50)}`, current, identity)).toBe("elided");
    // The marker taking the last value's newline belongs to the last span.
    expect(compare(`${"x".repeat(500)}[REDACTED]end`, `${fold(4000)}\nend`, identity)).toBe("elided");
  });

  it("finds the values between folds in order", () => {
    const current = `${fold(100)}\nA\n${fold(100)}\nB\n${fold(100)}`;
    const span = "x".repeat(30);
    expect(compare(`${span}\nA\n${span}\nB\n${span}`, current, identity)).toBe("elided");
    expect(compare(`${span}\nB\n${span}\nA\n${span}`, current, identity)).toBeUndefined();
  });

  it("refuses a row whose redaction swallowed a placeholder, leaving nothing to anchor its span", () => {
    const scrubPassword = (text: string) => text.replace(/password:\s*\S+/g, "password: [REDACTED]");
    expect(compare(`password:\n${output(100)}`, `password:\n${fold(100)}`, scrubPassword)).toBeUndefined();
  });

  it("classifies a row cut at a NUL before the first placeholder as cut, but not one after it", () => {
    const current = `status ok\u0000trailing\n${fold(2000)}`;
    expect(compare("status ok", current, identity)).toBe("cut");
    expect(compare(`status ok�trailing\n${output(2000)}`, current, identity)).toBe("elided");
    // Text cut after a placeholder holds it, and a stored marker would stand for it.
    expect(compare("[REDACTED]", `${fold(2000)}\nx\u0000y`, identity)).toBeUndefined();
    // So does text cut before a later placeholder but after the first.
    expect(compare("[REDACTED]", `${fold(2000)}\nA\u0000B\n${fold(2000)}`, identity)).toBeUndefined();
  });

  it("compares only the text around placeholders the stored row already holds", () => {
    // Stored after the fold, under a redaction rule since removed: the placeholder hid nothing.
    const current = `deployed build ACME-123456 to staging\n${fold(4000)}`;
    expect(compare(`deployed build [REDACTED] to staging\n${fold(4000)}`, current, identity)).toBe("full");
    expect(compare(`deployed build [REDACTED] to staging\n${fold(4000, "0123456789ac")}`, current, identity)).toBeUndefined();
    expect(compare(`[REDACTED]\n${fold(100)}`, `a\n${fold(100)}\nlost text`, identity)).toBeUndefined();
    // The text before the first placeholder is compared too.
    expect(compare(`Verdict: rejected\n${fold(4000)}`, `Verdict: approved\n${fold(4000)}`, identity)).toBeUndefined();
    // The same placeholders, in another order.
    const swapped = (first: string, second: string) => `${fold(4000, first)}\nmid\n${fold(4000, second)}`;
    expect(compare(swapped("bbbbbbbbbbbb", "aaaaaaaaaaaa"), swapped("aaaaaaaaaaaa", "bbbbbbbbbbbb"), identity)).toBeUndefined();
    // A pattern rewriting part of a placeholder cannot let its marker reach past it.
    const scrubHashes = (text: string) => text.replace(/[0-9a-f]{12}/g, "[REDACTED]");
    expect(compare(`a\n${fold(100)}`, `a\n${fold(100)}\nextra]`, scrubHashes)).toBeUndefined();
    // Nor can a pattern that swallows one: the rows split into different numbers of parts.
    const scrubPassword = (text: string) => text.replace(/password:\s*\S+/g, "password: [REDACTED]");
    expect(compare(`password:\n${fold(4000)}`, `password: x\n${fold(4000)}\nlost text`, scrubPassword)).toBeUndefined();
  });

  it("finds held placeholders in the raw rows, before any pattern can rewrite them", () => {
    const scrubHex = (text: string) => text.replace(/\b[0-9a-f]{12}\b/g, "[REDACTED]");
    const row = (build: string) => `deployed build ${build} to staging\n${fold(4000)}`;
    expect(compare(row("[REDACTED]"), row("ACME-123456"), scrubHex)).toBe("full");
    // The stand-in is a character neither row holds.
    expect(compare(`${row("[REDACTED]")}`, `${row("ACME-123456")}`, identity)).toBe("full");
    // Each part is compared as stored, with a NUL as its replacement character.
    expect(compare(`a�[REDACTED]\n${fold(4000)}`, `a\u0000bc\n${fold(4000)}`, identity)).toBe("full");
  });

  it("does not treat a placeholder quoted inside a line as a fold", () => {
    expect(compare(`${output(100)} here`, `${fold(100)} here`, identity)).toBeUndefined();
    expect(compare(`see ${output(100)}`, `see ${fold(100)}`, identity)).toBeUndefined();
    expect(compare("see anything here", `see ${fold(4)} here`, identity)).toBeUndefined();
    const prose = "[tokenade:elided N tokens on cold resume — recover: tokenade expand-ref <hex>]";
    expect(compare("anything else", prose, identity)).toBeUndefined();
  });
});

describe("isTokenadeFold", () => {
  const fold = "[tokenade:elided 40 tokens on cold resume — recover: tokenade expand-ref 0123456789ab]";

  it("finds a placeholder that is the whole value or ends a kept opening", () => {
    expect(isTokenadeFold(fold)).toBe(true);
    expect(isTokenadeFold(`Verdict: ok\n${fold}`)).toBe(true);
  });

  it("takes a placeholder with text after it, or inside a line, for a quote", () => {
    expect(isTokenadeFold(`markers still present:\n${fold}\ncat: other.txt: No such file`)).toBe(false);
    expect(isTokenadeFold(`see ${fold} here`)).toBe(false);
    expect(isTokenadeFold(`see ${fold}`)).toBe(false);
  });
});
