import { describe, expect, test } from "bun:test";
import { claudeOptions } from "./options.ts";

describe("claudeOptions", () => {
  test("turns Claude's command-line flags into SDK options", () => {
    expect(claudeOptions(["--resume", "abc", "--permission-mode=plan", "--model", "haiku", "--verbose", "--add-dir", "/tmp"])).toEqual({
      resume: "abc",
      permissionMode: "plan",
      model: "haiku",
      additionalDirectories: ["/tmp"],
      extraArgs: { verbose: null },
    });
    expect(claudeOptions(["-c"])).toEqual({ continue: true });
    expect(claudeOptions(["--permission-mode", "plan"]).permissionMode).toBe("plan");
    expect(claudeOptions([])).toEqual({});
  });

  test("passes several values to flags that take a list, and repeated list flags", () => {
    expect(claudeOptions(["--allowedTools", "Bash", "Edit", "--add-dir", "/a", "--add-dir", "/b", "--disallowed-tools=Write", "--plugin-dir", "./p"])).toEqual({
      allowedTools: ["Bash", "Edit"],
      additionalDirectories: ["/a", "/b"],
      disallowedTools: ["Write"],
      plugins: [{ type: "local", path: "./p" }],
    });
  });

  test("takes the next argument as the value of a flag that needs one, even if it starts with -", () => {
    expect(claudeOptions(["--append-system-prompt", "-be terse", "--verbose"])).toEqual({ extraArgs: { "append-system-prompt": "-be terse", verbose: null } });
    expect(() => claudeOptions(["--model"])).toThrow("--model needs a value");
  });

  test("refuses prompts, short flags it can't name, and a bare --resume", () => {
    expect(() => claudeOptions(["fix the build"])).toThrow('not "fix the build"');
    expect(() => claudeOptions(["-v"])).toThrow("short flag -v");
    expect(() => claudeOptions(["--verbose", "--verbose"])).toThrow("--verbose to Claude only once");
    expect(() => claudeOptions(["--mcp-config", "a.json", "b.json"])).toThrow("only one value to --mcp-config");
    expect(() => claudeOptions(["--resume"])).toThrow("give --resume a session id");
    expect(() => claudeOptions(["-r", "--verbose"])).toThrow("give --resume a session id");
  });
});
