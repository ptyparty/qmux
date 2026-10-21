import { createCliRenderer } from "@opentui/core";
import { FormController, type FormResult } from "./controller.ts";
import type { FormSpec } from "./schema.ts";
import { runForm } from "./view.ts";

export async function showForm(spec: FormSpec, onExitSignal: () => Promise<unknown>): Promise<FormResult> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: false });
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = async () => {
    await onExitSignal();
    renderer.destroy();
    process.exit(130);
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    return await runForm(renderer, new FormController(spec));
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    renderer.destroy();
    await renderer.closed;
  }
}
