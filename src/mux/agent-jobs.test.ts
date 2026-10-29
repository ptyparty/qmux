import { describe, expect, test } from "bun:test";
import { refuseAgentCommand } from "./agent-jobs.ts";

const patterns = ["scripts/up", "scripts/nu-up", "scripts/build"];
const refused = (command: string, background = false, running: { name: string; command?: string[] }[] = []) => refuseAgentCommand(patterns, command, background, running);

describe("agent job commands", () => {
  test("a listed command run in the foreground, or detached, is refused with instructions", () => {
    expect(refused("cd merlin && ./scripts/up")).toStartWith("scripts/up must run in the background.");
    expect(refused("(which nu >/dev/null && ./scripts/nu-up --detach || ./scripts/up --detach) > log 2>&1", true)).toStartWith("Drop --detach from scripts/nu-up.");
    expect(refused("FOO=1 bash scripts/build")).toStartWith("scripts/build must run in the background.");
    expect(refused("FOO=1 bash -c 'cd x && scripts/build'")).toContain("run_in_background: true");
  });

  test("glued operators, keywords and launchers with options don't hide a run", () => {
    for (const command of ["cd merlin&&./scripts/up", "true;scripts/up", "{ scripts/up; }", "if true; then scripts/up; fi", "env -u FOO scripts/up", "sudo -u deploy scripts/up", "timeout 600 scripts/up", "nice -n 10 scripts/up", "echo $(scripts/up)"]) {
      expect([command, refused(command)?.slice(0, 10)]).toEqual([command, "scripts/up"]);
    }
  });

  test("background runs pass unless one is already running in the tab, and --detach counts only on the listed command", () => {
    expect(refused("./scripts/up", true)).toBeUndefined();
    expect(refused("./scripts/up & docker run --detach redis", true)).toBeUndefined();
    const running = [{ name: "Start Merlin", command: ["bash", "-c", "cd /w && ./scripts/up"] }];
    expect(refused("./scripts/up", true, running)).toContain('already running as the job "Start Merlin"');
    expect(refused("./scripts/build && ./scripts/up", true, running)).toContain('already running as the job "Start Merlin"');
    expect(refused("./scripts/build", true, running)).toBeUndefined();
  });

  test("mentioning a listed script without running it is fine", () => {
    for (const command of ["cat scripts/up; sed -n '1,20p;' ./scripts/up", "grep -n 'docker compose up -d &' scripts/up", "echo then scripts/up", "./scripts/re-up api", "less < scripts/up"]) {
      expect([command, refused(command)]).toEqual([command, undefined]);
    }
    expect(refuseAgentCommand([], "./scripts/up", false, [])).toBeUndefined();
  });
});
