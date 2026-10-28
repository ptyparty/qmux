import { askOwner } from "../ask/ask.ts";
import { askPermission, askPlan, askQuestions, type PermissionInput, type PermissionSuggestion, type PlanInput, type QuestionInput } from "../hooks/hook.ts";

export type PermissionRequest = { tool_name: string; input: Record<string, unknown>; permission_suggestions?: PermissionSuggestion[] };

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

type Decision = { behavior?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; interrupt?: boolean };
type HookOutput = { hookSpecificOutput?: { decision?: Decision; permissionDecision?: string; updatedInput?: Record<string, unknown> } };

const unanswered: PermissionResult = { behavior: "deny", message: "No answer from the user" };

export async function decidePermission(request: PermissionRequest, env: Record<string, string | undefined> = process.env): Promise<PermissionResult> {
  const owner = askOwner(env);
  if (!owner) return { behavior: "deny", message: "Nobody could answer: this session is not running inside qmux" };
  const tool_input = request.input;
  switch (request.tool_name) {
    case "ExitPlanMode":
      return controlResult(request, await askPlan(owner, { hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input } as PlanInput));
    case "AskUserQuestion":
      if (tool_input.answers) return { behavior: "allow", updatedInput: tool_input };
      return controlResult(request, await askQuestions(owner, { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input } as QuestionInput));
    default: {
      const input: PermissionInput = { hook_event_name: "PermissionRequest", tool_name: request.tool_name, tool_input, permission_suggestions: request.permission_suggestions };
      return controlResult(request, await askPermission(owner, input));
    }
  }
}

export function controlResult(request: PermissionRequest, output: object | undefined): PermissionResult {
  const specific = (output as HookOutput | undefined)?.hookSpecificOutput;
  const decision = specific?.decision;
  if (decision?.behavior === "allow") {
    return { behavior: "allow", updatedInput: decision.updatedInput ?? request.input, ...(decision.updatedPermissions && { updatedPermissions: decision.updatedPermissions }) };
  }
  if (decision?.behavior === "deny") return { behavior: "deny", message: decision.message ?? "The user denied this", ...(decision.interrupt && { interrupt: true }) };
  if (specific?.permissionDecision === "allow") return { behavior: "allow", updatedInput: specific.updatedInput ?? request.input };
  return unanswered;
}
