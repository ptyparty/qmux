import { createCliRenderer } from "@opentui/core";
import { FormController, type FormResult } from "./controller.ts";
import type { FormSpec } from "./schema.ts";
import { runForm } from "./view.ts";

export async function showForm(spec: FormSpec, onExitSignal: () => Promise<unknown>, close?: AbortSignal): Promise<FormResult> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = async () => {
    await onExitSignal();
    renderer.destroy();
    process.exit(130);
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    let onClose = () => {};
    const closed = new Promise<FormResult>((resolve) => {
      onClose = () => resolve({ status: "cancelled" });
      if (close?.aborted) onClose();
      else close?.addEventListener("abort", onClose, { once: true });
    });
    try {
      return await Promise.race([runForm(renderer, new FormController(spec)), closed]);
    } finally {
      close?.removeEventListener("abort", onClose);
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    renderer.destroy();
    await renderer.closed;
  }
}
