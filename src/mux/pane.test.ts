import { describe, expect, test } from "bun:test";
import { ClipboardScanner, programOf } from "./pane.ts";

describe("programOf", () => {
  test("names the program from a shell's command line", () => {
    expect(programOf("cmdline_url=hx%20src/a%20b.ts")).toBe("hx");
    expect(programOf("cmdline_url=/usr/bin/claude%20--resume")).toBe("claude");
    expect(programOf("cmdline_url=FOO=1%20BAR=2%20remax")).toBe("remax");
    expect(programOf("aid=7;cmdline_url=%20%20cargo%20build")).toBe("cargo");
  });

  test("gives nothing when the shell did not say", () => {
    expect(programOf(undefined)).toBeUndefined();
    expect(programOf("")).toBeUndefined();
    expect(programOf("cmdline_url=%E0%A4%A")).toBeUndefined();
  });
});

describe("ClipboardScanner", () => {
  const bytes = (text: string) => Buffer.from(text, "latin1");
  const write = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}`;

  test("reads writes ended by BEL or ST", () => {
    const scanner = new ClipboardScanner();
    expect(scanner.scan(bytes(`before${write("hi")}\x07after`))).toEqual(["hi"]);
    expect(scanner.scan(bytes(`${write("héllo ⛵")}\x1b\\`))).toEqual(["héllo ⛵"]);
  });

  test("reads a write split across chunks", () => {
    const scanner = new ClipboardScanner();
    const sequence = `${write("split payload")}\x1b\\`;
    expect(scanner.scan(bytes(`x${sequence.slice(0, 3)}`))).toEqual([]);
    expect(scanner.scan(bytes(sequence.slice(3, 12)))).toEqual([]);
    expect(scanner.scan(bytes(sequence.slice(12, -1)))).toEqual([]);
    expect(scanner.scan(bytes(sequence.slice(-1)))).toEqual(["split payload"]);
  });

  test("ignores queries and empty writes", () => {
    const scanner = new ClipboardScanner();
    expect(scanner.scan(bytes("\x1b]52;c;?\x07\x1b]52;c;\x07"))).toEqual([]);
    expect(scanner.scan(bytes(`${write("next")}\x07`))).toEqual(["next"]);
  });

  test("reports each write once", () => {
    const scanner = new ClipboardScanner();
    expect(scanner.scan(bytes(`${write("once")}\x07`))).toEqual(["once"]);
    expect(scanner.scan(bytes("more output"))).toEqual([]);
  });
});
