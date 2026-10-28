import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../ask/store.ts";
import { serveControl, type ControlRequest } from "../mux/control.ts";
import { permissionDecision, permissionForm, planDecision, planForm, questionAnswers, questionForm, runHook, stateForEvent, type ClaudeQuestion, type PermissionInput } from "./hook.ts";

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

  test("plan review renders the plan and maps answers to Claude decisions", () => {
    const toolInput = { plan: "# Plan", planFilePath: "/tmp/plan.md" };
    expect(planForm("# Plan").elements[0]).toEqual({ type: "markdown", text: "# Plan" });
    const decision = (answer: Parameters<typeof planDecision>[1]) => (planDecision(toolInput, answer) as { hookSpecificOutput: { decision: unknown } } | undefined)?.hookSpecificOutput.decision;
    const allow = (mode: string) => ({ behavior: "allow", updatedInput: toolInput, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });
    expect(decision({ decision: "auto" })).toEqual(allow("auto"));
    expect(decision({ decision: "edits" })).toEqual(allow("acceptEdits"));
    expect(decision({ decision: "review" })).toEqual(allow("default"));
    expect(decision({ decision: "keep", feedback: " Split step 2 " })).toEqual({ behavior: "deny", message: "Split step 2" });
    expect(decision({ decision: "keep", feedback: "" })).toEqual({ behavior: "deny", message: "The user wants to keep planning." });
    expect(decision("dismissed")).toEqual({ behavior: "deny", message: "The user dismissed the plan.", interrupt: true });
    expect(decision({})).toBeUndefined();
  });

  test("a background session's hook reports to the pane it is attached in", async () => {
    const socket = join(dir, "attached.sock");
    const proc = join(dir, "proc");
    mkdirSync(join(proc, "42"), { recursive: true });
    writeFileSync(join(proc, "42", "cmdline"), "claude\0attach\0e3002ad1\0");
    writeFileSync(join(proc, "42", "environ"), `QMUX_SOCKET=${socket}\0QMUX_PANE_ID=7\0`);
    const requests: ControlRequest[] = [];
    const server = serveControl(socket, (request) => {
      requests.push(request);
      return { ok: true };
    });
    const previousSocket = process.env.QMUX_SOCKET;
    const previousPane = process.env.QMUX_PANE_ID;
    try {
      await runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "e3002ad1-66a9-4a1c" }), {}, proc);
    } finally {
      server.stop();
      restore("QMUX_SOCKET", previousSocket);
      restore("QMUX_PANE_ID", previousPane);
    }
    expect(requests).toEqual([{ method: "agent.state", params: { paneId: 7, state: "done" } }]);
  });

  test("a prompt tells the agent about forms closed while it was not waiting", async () => {
    const env = { QMUX_SOCKET: join(dir, "missing.sock"), QMUX_PANE_ID: "9", QMUX_STATE_DIR: join(dir, "notice-state") };
    const previous = process.env.QMUX_STATE_DIR;
    process.env.QMUX_STATE_DIR = env.QMUX_STATE_DIR;
    try {
      const store = new AskStore();
      const owner = { socket: env.QMUX_SOCKET, paneId: 9 };
      const dismissed = await store.create({ title: "Which branch?", elements: [] }, "qmux", owner);
      const answered = await store.create({ title: "Ship it?", elements: [] }, "qmux", owner);
      await store.complete(dismissed.id, { status: "cancelled" });
      await store.complete(answered.id, { status: "submitted", values: { ship: true } });
      const prompt = JSON.stringify({ hook_event_name: "UserPromptSubmit" });
      const context = JSON.parse((await runHook(prompt, env))!).hookSpecificOutput.additionalContext;
      expect(context).toContain(`"Which branch?" (${dismissed.id}) was dismissed`);
      expect(context).toContain(`"Ship it?" (${answered.id}) was answered: {"ship":true}`);
      expect(await runHook(prompt, env)).toBeUndefined();
    } finally {
      restore("QMUX_STATE_DIR", previous);
    }
  });

  test("does nothing outside qmux", async () => {
    expect(await runHook(JSON.stringify({ hook_event_name: "Stop" }), {})).toBeUndefined();
  });

  test("reports state changes and answers permission requests through a popup", async () => {
    const socket = join(dir, "control.sock");
    const requests: ControlRequest[] = [];
    const owners: unknown[] = [];
    const server = serveControl(socket, async (request) => {
      requests.push(request);
      if (request.method === "popup.open") {
        const command = request.params.command;
        const askId = command[command.indexOf("--ask") + 1]!;
        const store = new AskStore(command[command.indexOf("--asks-dir") + 1]!);
        owners.push((await store.meta(askId)).owner);
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
    expect(owners).toEqual([undefined]);
  });

  test("native qmux Claude sessions answer their own permission requests and questions", async () => {
    const env = { QMUX_SOCKET: "/nowhere", QMUX_PANE_ID: "7", QMUX_NATIVE_CLAUDE: "1" };
    const request = { hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "/a" } };
    const question = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Tea?", options: [{ label: "Yes" }] }] } };
    expect(await runHook(JSON.stringify(request), env)).toBeUndefined();
    expect(await runHook(JSON.stringify(question), env)).toBeUndefined();
  });
});
