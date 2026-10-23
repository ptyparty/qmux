import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../ask/store.ts";
import { serveControl, type ControlRequest } from "../mux/control.ts";
import { permissionDecision, permissionForm, questionAnswers, questionForm, runHook, stateForEvent, type ClaudeQuestion, type PermissionInput } from "./hook.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bash: PermissionInput = {
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf node_modules", description: "Remove node_modules" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf node_modules" }], behavior: "allow", destination: "localSettings" }],
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("qmux hook", () => {
  test("events map to agent states", () => {
    expect(stateForEvent({ hook_event_name: "UserPromptSubmit" })).toEqual({ state: "working" });
    expect(stateForEvent({ hook_event_name: "Stop" })).toEqual({ state: "done" });
    expect(stateForEvent({ hook_event_name: "SessionEnd" })).toEqual({ state: "clear" });
    expect(stateForEvent({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "needs permission" })).toEqual({
      state: "waiting",
      detail: "needs permission",
    });
    expect(stateForEvent({ hook_event_name: "Notification", notification_type: "idle_prompt" })).toMatchObject({ state: "done" });
    expect(stateForEvent({ hook_event_name: "Notification", notification_type: "auth_success" })).toBeUndefined();
    expect(stateForEvent({ hook_event_name: "SessionStart" })).toBeUndefined();
  });

  test("the permission form shows the command and offers the suggested rule", () => {
    const form = permissionForm(bash);
    expect(form.title).toBe("Allow Bash?");
    expect(form.description).toBe("Remove node_modules");
    expect(form.elements[0]).toEqual({ type: "note", text: "rm -rf node_modules" });
    expect(form.elements[1]).toMatchObject({ options: [{ value: "allow" }, { value: "always", description: "Bash(rm -rf node_modules) in local settings" }, { value: "deny" }] });
    expect(permissionForm({ ...bash, permission_suggestions: undefined }).elements[1]).toMatchObject({ options: [{ value: "allow" }, { value: "deny" }] });
  });

  test("answers become hook decisions", () => {
    const wrap = (decision: object) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    expect(permissionDecision(bash, { decision: "allow" })).toEqual(wrap({ behavior: "allow" }));
    expect(permissionDecision(bash, { decision: "always" })).toEqual(wrap({ behavior: "allow", updatedPermissions: [bash.permission_suggestions![0]] }));
    expect(permissionDecision(bash, { decision: "deny", reason: " too risky " })).toEqual(wrap({ behavior: "deny", message: "too risky" }));
    expect(permissionDecision(bash, { decision: "deny" })).toEqual(wrap({ behavior: "deny", message: "The user denied this in qmux" }));
  });

  test("Claude's questions become a form and its answers come back keyed by question", () => {
    const questions: ClaudeQuestion[] = [
      { question: "Which framework?", header: "Framework", options: [{ label: "React", description: "Components" }, { label: "Vue" }], multiSelect: false },
      { question: "Which checks?", options: [{ label: "lint" }, { label: "test" }], multiSelect: true },
    ];
    const form = questionForm(questions);
    expect(form.title).toBe("Claude asks: Framework");
    expect(form.elements).toMatchObject([
      { type: "choice", id: "q0", label: "Which framework?", multi: false, options: [{ value: "React", description: "Components" }, { value: "Vue" }] },
      { type: "choice", id: "q1", multi: true },
    ]);
    expect(questionAnswers(questions, { q0: "Svelte", q1: ["lint", "test"] })).toEqual({ "Which framework?": "Svelte", "Which checks?": "lint, test" });
  });

  test("plan approval is left to Claude's own dialog", async () => {
    const socket = join(dir, "plan.sock");
    const requests: ControlRequest[] = [];
    const server = serveControl(socket, (request) => {
      requests.push(request);
      return { ok: true };
    });
    try {
      const output = await runHook(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan" } }), { QMUX_SOCKET: socket, QMUX_PANE_ID: "3" });
      expect(output).toBeUndefined();
    } finally {
      server.stop();
    }
    expect(requests).toEqual([{ method: "agent.state", params: { paneId: 3, state: "waiting", detail: "Claude has a plan for you to review" } }]);
  });

  test("does nothing outside qmux", async () => {
    expect(await runHook(JSON.stringify({ hook_event_name: "Stop" }), {})).toBeUndefined();
  });

  test("reports state changes and answers permission requests through a popup", async () => {
    const socket = join(dir, "control.sock");
    const requests: ControlRequest[] = [];
    const server = serveControl(socket, async (request) => {
      requests.push(request);
      if (request.method === "popup.open") {
        const command = request.params.command;
        const askId = command[command.indexOf("--ask") + 1]!;
        const store = new AskStore(command[command.indexOf("--asks-dir") + 1]!);
        setTimeout(() => store.complete(askId, { status: "submitted", values: { decision: "deny", reason: "not now" } }), 20);
      }
      return { ok: true };
    });
    const env = { QMUX_SOCKET: socket, QMUX_PANE_ID: "7", QMUX_STATE_DIR: join(dir, "state") };
    const previous = process.env.QMUX_STATE_DIR;
    const previousSocket = process.env.QMUX_SOCKET;
    const previousPane = process.env.QMUX_PANE_ID;
    Object.assign(process.env, env);
    try {
      expect(await runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit" }), env)).toBeUndefined();
      const output = await runHook(JSON.stringify(bash), env);
      expect(JSON.parse(output!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } } });
    } finally {
      server.stop();
      restore("QMUX_STATE_DIR", previous);
      restore("QMUX_SOCKET", previousSocket);
      restore("QMUX_PANE_ID", previousPane);
    }
    expect(requests.map((request) => request.method)).toEqual(["agent.state", "agent.state", "popup.open", "agent.state"]);
    expect(requests[0]).toEqual({ method: "agent.state", params: { paneId: 7, state: "working" } });
    expect(requests[2]).toMatchObject({ params: { title: "Allow Bash?", paneId: 7 } });
  });
});
