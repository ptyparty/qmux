import { ask, askOwner } from "../ask/ask.ts";
import { AskStore, type AskOwner, type AskStatus, type UnseenResult } from "../ask/store.ts";
import type { FormSpec } from "../form/schema.ts";
import { ControlError, sendControl, type ControlRequest } from "../mux/control.ts";
import { attachedPaneEnv } from "./attached.ts";

export type HookInput = { hook_event_name?: string; message?: string; notification_type?: string; [key: string]: unknown };

type AgentStateRequest = Extract<ControlRequest, { method: "agent.state" }>;
type AgentStateName = AgentStateRequest["params"]["state"];

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

export async function askPermission(pane: AskOwner, input: PermissionInput): Promise<object | undefined> {
  const values = submitted(await askInPopup(pane, permissionForm(input), `Claude wants to use ${input.tool_name}`));
  return values && permissionDecision(input, values);
}

export type PlanInput = { hook_event_name: "PermissionRequest"; tool_name: "ExitPlanMode"; tool_input: { plan?: unknown; [key: string]: unknown } };

export function planForm(plan: string): FormSpec {
  return {
    title: "Claude's plan",
    elements: [
      { type: "markdown", text: plan },
      {
        type: "choice",
        id: "decision",
        label: "Ready to code?",
        other: false,
        default: "auto",
        options: [
          { value: "auto", label: "Yes, and use auto mode" },
          { value: "edits", label: "Yes, and auto-accept edits" },
          { value: "review", label: "Yes, and review each edit" },
          { value: "keep", label: "No, keep planning" },
        ],
      },
      { type: "text", id: "feedback", label: "What should Claude change?", multiline: true, when: 'selected(decision, "keep")' },
    ],
    submitLabel: "Answer",
  };
}

export type PlanAnswer = { decision?: unknown; feedback?: unknown };

export function planDecision(toolInput: PlanInput["tool_input"], answer: PlanAnswer | "dismissed"): object | undefined {
  const reply = (decision: object) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  const allow = (mode: string) => reply({ behavior: "allow", updatedInput: toolInput, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });
  const deny = (message: string) => reply({ behavior: "deny", message });
  if (answer === "dismissed") return reply({ behavior: "deny", message: "The user dismissed the plan.", interrupt: true });
  switch (answer.decision) {
    case "auto":
      return allow("auto");
    case "edits":
      return allow("acceptEdits");
    case "review":
      return allow("default");
    case "keep": {
      const feedback = typeof answer.feedback === "string" && answer.feedback.trim() ? answer.feedback.trim() : "The user wants to keep planning.";
      return deny(feedback);
    }
    default:
      return undefined;
  }
}

export async function askPlan(pane: AskOwner, input: PlanInput): Promise<object | undefined> {
  const plan = input.tool_input.plan;
  if (typeof plan !== "string" || !plan.trim()) return undefined;
  const status = await askInPopup(pane, planForm(plan), "Claude has a plan for you to review");
  if (status?.status === "cancelled") {
    await reportState(pane, "done");
    return planDecision(input.tool_input, "dismissed");
  }
  const values = submitted(status);
  return values && planDecision(input.tool_input, values);
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

export async function askQuestions(pane: AskOwner, input: QuestionInput): Promise<object | undefined> {
  const questions = input.tool_input.questions ?? [];
  if (questions.length === 0) return undefined;
  const values = submitted(await askInPopup(pane, questionForm(questions), "Claude has a question"));
  if (!values) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input, answers: questionAnswers(questions, values) },
    },
  };
}

async function askInPopup(pane: AskOwner, spec: FormSpec, waitingFor: string): Promise<AskStatus | undefined> {
  await reportState(pane, "waiting", waitingFor);
  let outcome;
  try {
    outcome = await ask(new AskStore(), spec, "qmux", Number.POSITIVE_INFINITY, {});
  } catch {
    return undefined;
  }
  if (outcome.status.status === "submitted") await reportState(pane, "working");
  return outcome.status;
}

function submitted(status: AskStatus | undefined): Record<string, unknown> | undefined {
  return status?.status === "submitted" ? status.values : undefined;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && seen.add(key(item)));
}

export async function runHook(stdin: string, env: Record<string, string | undefined>, procDir?: string): Promise<string | undefined> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return undefined;
  }
  let pane = askOwner(env);
  if (!pane) {
    const attached = attachedPaneEnv(input.session_id, procDir);
    pane = attached && askOwner(attached);
    if (!pane) return undefined;
    Object.assign(process.env, attached);
  }
  const asksUser = input.hook_event_name === "PermissionRequest" || (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion");
  if (asksUser && env.QMUX_NATIVE_CLAUDE) return undefined;
  if (input.hook_event_name === "PermissionRequest" && input.tool_name === "ExitPlanMode") {
    const decision = await askPlan(pane, input as unknown as PlanInput);
    return decision ? JSON.stringify(decision) : undefined;
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
  if (input.hook_event_name === "UserPromptSubmit") {
    const notice = unseenNotice(await new AskStore().claimUnseen(pane));
    return notice && JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notice } });
  }
  return undefined;
}

export function unseenNotice(unseen: UnseenResult[]): string | undefined {
  if (unseen.length === 0) return undefined;
  const lines = unseen.map(({ meta, result }) =>
    result.status === "submitted"
      ? `- "${meta.title}" (${meta.id}) was answered: ${JSON.stringify(result.values)}`
      : `- "${meta.title}" (${meta.id}) was dismissed without an answer. Its popup is closed.`,
  );
  return ["qmux forms you opened were closed since you last checked on them:", ...lines].join("\n");
}

export function summarizeToolInput(toolInput: Record<string, unknown>): string {
  const preferred = ["command", "file_path", "path", "url", "pattern", "query"].find((key) => typeof toolInput[key] === "string");
  const text = preferred ? String(toolInput[preferred]) : JSON.stringify(toolInput, null, 2);
  return text.length > maxShown ? `${text.slice(0, maxShown)}…` : text;
}

function describeSuggestion(suggestion: PermissionSuggestion): string {
  const rules = (suggestion.rules ?? []).map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName));
  const where = suggestion.destination ? ` in ${suggestion.destination.replace(/Settings$/, " settings")}` : "";
  return `${rules.join(", ") || suggestion.type}${where}`;
}

export async function reportState(pane: AskOwner, state: AgentStateName, detail?: string): Promise<void> {
  try {
    await sendControl(pane.socket, { method: "agent.state", params: { paneId: pane.paneId, state, detail } }, 1000);
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
  }
}
