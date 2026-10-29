import { describe, expect, test } from "bun:test";
import { shellWords } from "../ask/hosts.ts";
import { installHooks, missingHooks, type Settings } from "./hooks-setup.ts";

const ours = "/home/me/.bun/bin/bun /home/me/.bun/bin/qmux hook";
const hook = (timeout: number) => [{ type: "command", command: ours, timeout }];

const current: Settings = {
  model: "opus",
  hooks: {
    UserPromptSubmit: [{ hooks: hook(10) }],
    Stop: [{ hooks: hook(10) }],
    Notification: [{ matcher: "*", hooks: hook(10) }],
    PermissionRequest: [{ matcher: "*", hooks: hook(3600) }],
    PreToolUse: [
      { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] },
      { matcher: "AskUserQuestion", hooks: hook(3600) },
    ],
    SessionEnd: [{ hooks: hook(5) }],
  },
};

describe("qmux hooks in Claude settings", () => {
  test("every hook is missing from empty settings", () => {
    expect(missingHooks([{}])).toHaveLength(8);
  });

  test("hooks that are missing or too narrow are reported", () => {
    expect(missingHooks([current]).map((hook) => hook.label)).toEqual(["Stop (wake)", "PreToolUse [AskUserQuestion|Bash]: widen matcher", "SessionStart"]);
  });

  test("installing adds what is missing with the command already in use, and keeps everything else", () => {
    const installed = installHooks(current, [], "/elsewhere/qmux hook");
    expect(missingHooks([installed])).toEqual([]);
    expect(installed.model).toBe("opus");
    expect(installed.hooks!.PreToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] },
      { matcher: "AskUserQuestion|Bash", hooks: hook(3600) },
    ]);
    expect(installed.hooks!.Stop![1]).toEqual({ hooks: [{ type: "command", command: `${ours} --wake`, timeout: 86400, async: true, asyncRewake: true }] });
    expect(installed.hooks!.SessionStart).toEqual([{ hooks: hook(5) }]);
    expect(current.hooks!.PreToolUse![1]!.matcher).toBe("AskUserQuestion");
  });

  test("a wake hook that does not run async is upgraded", () => {
    const settings: Settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: `${ours} --wake` }] }] } };
    expect(missingHooks([settings]).map((hook) => hook.label)).toContain("Stop (wake): run async with asyncRewake");
    const wake = installHooks(settings, [], ours).hooks!.Stop!.flatMap((group) => group.hooks!).find((hook) => hook.command!.endsWith("--wake"));
    expect(wake).toMatchObject({ async: true, asyncRewake: true, timeout: 86400 });
  });

  test("qmux's hook leaves a shared group instead of widening it for the other hooks there", () => {
    const shared: Settings = { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [...hook(3600), { type: "command", command: "./audit.sh" }] }] } };
    expect(installHooks(shared, [], ours).hooks!.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "./audit.sh" }] },
      { matcher: "AskUserQuestion|Bash", hooks: hook(3600) },
    ]);
  });

  test("hooks in settings.local.json count, regex matchers are read as regexes, and short timeouts are raised", () => {
    const local: Settings = { hooks: { SessionStart: [{ hooks: hook(5) }], PreToolUse: [{ matcher: "Ask.*|Bash", hooks: hook(3600) }] } };
    const labels = missingHooks([current, local]).map((problem) => problem.label);
    expect(labels).toEqual(["Stop (wake)"]);
    expect(installHooks(current, [local], ours).hooks!.SessionStart).toBeUndefined();
    const short: Settings = { hooks: { PermissionRequest: [{ matcher: "*", hooks: hook(60) }] } };
    expect(missingHooks([short]).map((problem) => problem.label)).toContain("PermissionRequest: raise timeout to 3600s");
    const startupOnly: Settings = { hooks: { SessionStart: [{ matcher: "startup", hooks: hook(5) }] } };
    expect(missingHooks([startupOnly]).map((problem) => problem.label)).toContain("SessionStart: widen matcher");
  });

  test("a quoted hook command with spaces in its path is still recognised", () => {
    expect(shellWords(`'/my tools/bun' "/my dir/cli.ts" hook --wake`)).toEqual(["/my tools/bun", "/my dir/cli.ts", "hook", "--wake"]);
    const quoted: Settings = installHooks({}, [], `'/my tools/bun' '/my dir/cli.ts' hook`);
    expect(missingHooks([quoted])).toEqual([]);
  });
});
