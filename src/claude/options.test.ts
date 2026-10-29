import { describe, expect, test } from "bun:test";
import { claudeOptions } from "./options.ts";

describe("claudeOptions", () => {
  test("turns Claude's command-line flags into SDK options", () => {
    expect(claudeOptions(["--resume", "abc", "--permission-mode=plan", "--model", "haiku", "--verbose", "--add-dir", "/tmp"])).toEqual({
      resume: "abc",
      permissionMode: "plan",
      model: "haiku",
      extraArgs: { verbose: null, "add-dir": "/tmp" },
    });
    expect(claudeOptions(["-c"])).toEqual({ continue: true });
    expect(claudeOptions(["--permission-mode", "plan"]).permissionMode).toBe("plan");
    expect(claudeOptions([])).toEqual({});
  });

  test("refuses prompts and short flags it can't name", () => {
    expect(() => claudeOptions(["fix the build"])).toThrow('not "fix the build"');
    expect(() => claudeOptions(["-v"])).toThrow("short flag -v");
    expect(() => claudeOptions(["--add-dir", "/a", "--add-dir", "/b"])).toThrow("--add-dir to Claude only once");
  });
});
