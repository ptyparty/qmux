import { ask } from "../ask/ask.ts";
import { AskStore } from "../ask/store.ts";
import type { FormSpec } from "../form/schema.ts";
import { ControlError, sendControl, type ControlRequest } from "../mux/control.ts";

export type HookInput = { hook_event_name?: string; message?: string; notification_type?: string; [key: string]: unknown };

type AgentStateRequest = Extract<ControlRequest, { method: "agent.state" }>;
type AgentStateName = AgentStateRequest["params"]["state"];

export type QmuxPane = { socket: string; paneId: number };

export function qmuxPane(env: Record<string, string | undefined>): QmuxPane | undefined {
  const paneId = Number(env.QMUX_PANE_ID);
  if (!env.QMUX_SOCKET || !Number.isInteger(paneId)) return undefined;
  return { socket: env.QMUX_SOCKET, paneId };
}

export function stateForEvent(input: HookInput): { state: AgentStateName; detail?: string } | undefined {
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return { state: "working" };
    case "Stop":
      return { state: "done" };
    case "SessionEnd":
      return { state: "clear" };
    case "Notification": {
      const detail = typeof input.message === "string" ? input.message : undefined;
      if (input.notification_type === "idle_prompt") return { state: "done", detail };
      if (needsYou.has(String(input.notification_type))) return { state: "waiting", detail };
      return undefined;
    }
    default:
      return undefined;
  }
}

const needsYou = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

export type PermissionSuggestion = { type: string; rules?: { toolName: string; ruleContent?: string }[]; behavior?: string; destination?: string };

export type PermissionInput = {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
};

const maxShown = 600;

export function permissionForm(input: PermissionInput): FormSpec {
  const always = input.permission_suggestions?.[0];
  const description = typeof input.tool_input.description === "string" ? input.tool_input.description : undefined;
  return {
    title: `Allow ${input.tool_name}?`,
    description,
    elements: [
      { type: "note", text: summarizeToolInput(input.tool_input) },
      {
        type: "choice",
        id: "decision",
        label: "What should Claude do?",
        other: false,
        default: "allow",
        options: [
          { value: "allow", label: "Allow once" },
          ...(always ? [{ value: "always", label: "Always allow", description: describeSuggestion(always) }] : []),
          { value: "deny", label: "Deny" },
        ],
      },
      { type: "text", id: "reason", label: "Tell Claude why (optional)", when: 'selected(decision, "deny")' },
    ],
    submitLabel: "Answer",
  };
}

export type PermissionAnswer = { decision?: unknown; reason?: unknown };

export function permissionDecision(input: PermissionInput, answer: PermissionAnswer): object | undefined {
  const reply = (decision: object) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  switch (answer.decision) {
    case "allow":
      return reply({ behavior: "allow" });
    case "always": {
      const suggestion = input.permission_suggestions?.[0];
      return reply(suggestion ? { behavior: "allow", updatedPermissions: [suggestion] } : { behavior: "allow" });
    }
    case "deny": {
      const reason = typeof answer.reason === "string" && answer.reason.trim() ? answer.reason.trim() : "The user denied this in qmux";
      return reply({ behavior: "deny", message: reason });
    }
    default:
      return undefined;
  }
}

export async function askPermission(pane: QmuxPane, input: PermissionInput): Promise<object | undefined> {
  const values = await askInPopup(pane, permissionForm(input), `Claude wants to use ${input.tool_name}`);
  return values && permissionDecision(input, values);
}

export type ClaudeQuestion = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };

export type QuestionInput = { hook_event_name: "PreToolUse"; tool_name: "AskUserQuestion"; tool_input: { questions: ClaudeQuestion[] } };

export function questionForm(questions: ClaudeQuestion[]): FormSpec {
  return {
    title: questions[0]?.header ? `Claude asks: ${questions[0].header}` : "Claude has a question",
    elements: questions.map((question, index) => ({
      type: "choice" as const,
      id: `q${index}`,
      label: question.question,
      multi: Boolean(question.multiSelect),
      required: true,
      options: uniqueBy(question.options, (option) => option.label).map((option) => ({ value: option.label, label: option.label, description: option.description })),
    })),
    submitLabel: "Answer",
  };
}

export function questionAnswers(questions: ClaudeQuestion[], values: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const value = values[`q${index}`];
    if (Array.isArray(value)) answers[question.question] = value.join(", ");
    else if (typeof value === "string") answers[question.question] = value;
  });
  return answers;
}

export async function askQuestions(pane: QmuxPane, input: QuestionInput): Promise<object | undefined> {
  const questions = input.tool_input.questions ?? [];
  if (questions.length === 0) return undefined;
  const values = await askInPopup(pane, questionForm(questions), "Claude has a question");
  if (!values) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input, answers: questionAnswers(questions, values) },
    },
  };
}

async function askInPopup(pane: QmuxPane, spec: FormSpec, waitingFor: string): Promise<Record<string, unknown> | undefined> {
  await reportState(pane, "waiting", waitingFor);
  let outcome;
  try {
    outcome = await ask(new AskStore(), spec, "qmux", Number.POSITIVE_INFINITY);
  } catch {
    return undefined;
  }
  if (outcome.status.status !== "submitted") return undefined;
  await reportState(pane, "working");
  return outcome.status.values;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && seen.add(key(item)));
}

export async function runHook(stdin: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  const pane = qmuxPane(env);
  if (!pane) return undefined;
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return undefined;
  }
  if (input.hook_event_name === "PermissionRequest" && input.tool_name === "ExitPlanMode") {
    await reportState(pane, "waiting", "Claude has a plan for you to review");
    return undefined;
  }
  if (input.hook_event_name === "PermissionRequest") {
    const decision = await askPermission(pane, input as unknown as PermissionInput);
    return decision ? JSON.stringify(decision) : undefined;
  }
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
    const answer = await askQuestions(pane, input as unknown as QuestionInput);
    return answer ? JSON.stringify(answer) : undefined;
  }
  const update = stateForEvent(input);
  if (update) await reportState(pane, update.state, update.detail);
  return undefined;
}

function summarizeToolInput(toolInput: Record<string, unknown>): string {
  const preferred = ["command", "file_path", "path", "url", "pattern", "query"].find((key) => typeof toolInput[key] === "string");
  const text = preferred ? String(toolInput[preferred]) : JSON.stringify(toolInput, null, 2);
  return text.length > maxShown ? `${text.slice(0, maxShown)}…` : text;
}

function describeSuggestion(suggestion: PermissionSuggestion): string {
  const rules = (suggestion.rules ?? []).map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName));
  const where = suggestion.destination ? ` in ${suggestion.destination.replace(/Settings$/, " settings")}` : "";
  return `${rules.join(", ") || suggestion.type}${where}`;
}

export async function reportState(pane: QmuxPane, state: AgentStateName, detail?: string): Promise<void> {
  try {
    await sendControl(pane.socket, { method: "agent.state", params: { paneId: pane.paneId, state, detail } }, 1000);
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
  }
}
