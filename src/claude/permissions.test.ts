import { describe, expect, test } from "bun:test";
import { permissionDecision, planDecision } from "../hooks/hook.ts";
import { controlResult, decidePermission, type PermissionRequest } from "./permissions.ts";

const write: PermissionRequest = {
  tool_name: "Write",
  input: { file_path: "/tmp/a.txt", content: "hi" },
  permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" } as never],
};

const hookInput = { hook_event_name: "PermissionRequest" as const, tool_name: write.tool_name, tool_input: write.input, permission_suggestions: write.permission_suggestions };

describe("controlResult", () => {
  test("allow passes the tool's input back", () => {
    expect(controlResult(write, permissionDecision(hookInput, { decision: "allow" }))).toEqual({ behavior: "allow", updatedInput: write.input });
  });

  test("always allow carries the suggested permission", () => {
    expect(controlResult(write, permissionDecision(hookInput, { decision: "always" }))).toEqual({
      behavior: "allow",
      updatedInput: write.input,
      updatedPermissions: write.permission_suggestions,
    });
  });

  test("deny carries the user's reason", () => {
    expect(controlResult(write, permissionDecision(hookInput, { decision: "deny", reason: "not there" }))).toEqual({ behavior: "deny", message: "not there" });
  });

  test("plan approval switches the mode and a dismissed plan interrupts", () => {
    const plan: PermissionRequest = { tool_name: "ExitPlanMode", input: { plan: "do it" } };
    expect(controlResult(plan, planDecision(plan.input, { decision: "edits" }))).toEqual({
      behavior: "allow",
      updatedInput: plan.input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(controlResult(plan, planDecision(plan.input, "dismissed"))).toEqual({ behavior: "deny", message: "The user dismissed the plan.", interrupt: true });
  });

  test("no answer denies", () => {
    expect(controlResult(write, undefined)).toEqual({ behavior: "deny", message: "No answer from the user" });
  });
});

describe("decidePermission", () => {
  test("outside qmux nobody can answer, so it denies", async () => {
    expect(await decidePermission(write, {})).toEqual({ behavior: "deny", message: "Nobody could answer: this session is not running inside qmux" });
  });

  test("questions that already carry answers go ahead", async () => {
    const question: PermissionRequest = { tool_name: "AskUserQuestion", input: { questions: [], answers: { "Which?": "A" } } };
    expect(await decidePermission(question, { QMUX_SOCKET: "/nowhere", QMUX_PANE_ID: "3" })).toEqual({ behavior: "allow", updatedInput: question.input });
  });
});
