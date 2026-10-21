import type { FormSpec } from "../form/schema.ts";
import { launchForm, resolveHost, type HostName, type Launch } from "./hosts.ts";
import type { AskStatus, AskStore } from "./store.ts";

export class AlreadyAnsweredError extends Error {}

export type AskOutcome = { id: string; launch: Launch; status: AskStatus };

export async function ask(store: AskStore, spec: FormSpec, host: HostName, waitMs: number): Promise<AskOutcome> {
  const resolved = resolveHost(host);
  const meta = await store.create(spec, resolved);
  let launch: Launch;
  try {
    launch = await launchForm(resolved, meta.id, spec.title, store.root);
  } catch (error) {
    store.remove(meta.id);
    throw error;
  }
  const status = waitMs > 0 ? await store.wait(meta.id, waitMs) : await store.status(meta.id);
  return { id: meta.id, launch, status };
}

export async function reopen(store: AskStore, id: string, host: HostName): Promise<Launch> {
  const status = await store.status(id);
  if (status.status !== "pending") throw new AlreadyAnsweredError(`ask ${id} was already ${status.status}`);
  const spec = await store.spec(id);
  return launchForm(resolveHost(host), id, spec.title, store.root);
}

export async function answer(store: AskStore, id: string): Promise<AskStatus> {
  const existing = await store.status(id);
  if (existing.status !== "pending") return notice(`This question was already ${existing.status}.`, existing);
  const { showForm } = await import("../form/show.ts");
  const result = await showForm(await store.spec(id), () => store.complete(id, { status: "cancelled" }));
  if (await store.complete(id, result)) return result;
  const recorded = await store.status(id);
  return notice(`Your answer was not recorded: this question was already ${recorded.status} in another window.`, recorded);
}

async function notice(message: string, status: AskStatus): Promise<AskStatus> {
  console.error(message);
  await Bun.sleep(2000);
  return status;
}
