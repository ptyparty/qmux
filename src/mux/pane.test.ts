import { describe, expect, test } from "bun:test";
import { programOf } from "./pane.ts";

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
