import type { FormSpec } from "../form/schema.ts";
import type { AgentState } from "./workspace.ts";

export function peekSpec(title: string, text: string): FormSpec {
  return {
    title,
    elements: [
      { type: "markdown", text },
      { type: "text", id: "reply", label: "Reply", multiline: true, placeholder: "Ctrl+s sends · Esc closes" },
    ],
    submitLabel: "Send",
  };
}

export type PromptRoute = "socket" | "paste" | "busy";

export function promptRoute(native: boolean, state: AgentState | undefined): PromptRoute {
  if (native) return "socket";
  return state === "working" || state === "waiting" ? "busy" : "paste";
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\x1b\[201~/g, "")}\x1b[201~`;
}
