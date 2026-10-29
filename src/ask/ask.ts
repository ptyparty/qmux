import { resolveImagePaths, type FormSpec } from "../form/schema.ts";
import { launchForm, resolveHost, type HostName, type Launch } from "./hosts.ts";
import type { AskOwner, AskStatus, AskStore } from "./store.ts";

export class AlreadyAnsweredError extends Error {}

export type AskOutcome = { id: string; launch: Launch; status: AskStatus };

export type AskOptions = { owner?: AskOwner; signal?: AbortSignal };

export async function ask(store: AskStore, spec: FormSpec, host: HostName, waitMs: number, options: AskOptions = { owner: askOwner(process.env) }): Promise<AskOutcome> {
  const resolved = resolveHost(host);
  const meta = await store.create(resolveImagePaths(spec, process.cwd()), resolved, options.owner);
  let launch: Launch;
  try {
    launch = await launchForm(resolved, meta.id, spec.title, store.root);
  } catch (error) {
    store.remove(meta.id);
    throw error;
  }
  const cancel = () => void store.complete(meta.id, { status: "cancelled" }).catch(() => undefined);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    return { id: meta.id, launch, status: await store.wait(meta.id, waitMs) };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

export function askOwner(env: Record<string, string | undefined>): AskOwner | undefined {
  const paneId = Number(env.QMUX_PANE_ID);
  if (!env.QMUX_SOCKET || !env.QMUX_PANE_ID || !Number.isInteger(paneId)) return undefined;
  return { socket: env.QMUX_SOCKET, paneId, ...(env.QMUX_SERVER_ID && { server: env.QMUX_SERVER_ID }) };
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
  const answered = new AbortController();
  const done = new AbortController();
  void watchForAnswer(store, id, answered, done.signal);
  const result = await showForm(await store.spec(id), () => store.complete(id, { status: "cancelled" }), answered.signal);
  done.abort();
  if (answered.signal.aborted) return store.status(id);
  if (await store.complete(id, result)) return result;
  const recorded = await store.status(id);
  return notice(`Your answer was not recorded: this question was already ${recorded.status} in another window.`, recorded);
}

async function watchForAnswer(store: AskStore, id: string, answered: AbortController, done: AbortSignal): Promise<void> {
  while (!done.aborted) {
    await Bun.sleep(300);
    if (done.aborted) return;
    const status = await store.status(id).catch(() => undefined);
    if (status && status.status !== "pending") return answered.abort();
  }
}

async function notice(message: string, status: AskStatus): Promise<AskStatus> {
  console.error(message);
  await Bun.sleep(2000);
  return status;
}
