import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FormResult } from "../form/controller.ts";
import { parseFormSpec, type FormSpec } from "../form/schema.ts";

export type AskStatus = FormResult | { status: "pending" };

export type AskMeta = { id: string; title: string; createdAt: string; host: string };

const idPattern = /^[a-z0-9]+-[0-9a-f]{8}$/;
const pruneAgeMs = 24 * 60 * 60 * 1000;

export class UnknownAskError extends Error {
  constructor(id: string) {
    super(`no ask with id ${id}`);
  }
}

export class UnsafeAskRootError extends Error {}

export function defaultAskRoot(): string {
  if (process.env.QMUX_STATE_DIR) return join(process.env.QMUX_STATE_DIR, "asks");
  const runtime = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `qmux-${process.getuid?.() ?? "user"}`);
  return join(runtime, "qmux", "asks");
}

export class AskStore {
  constructor(readonly root: string = defaultAskRoot()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertPrivate(root);
  }

  async create(spec: FormSpec, host: string): Promise<AskMeta> {
    this.prune();
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const meta: AskMeta = { id, title: spec.title, createdAt: new Date().toISOString(), host };
    mkdirSync(this.dir(id), { mode: 0o700 });
    await Bun.write(join(this.dir(id), "spec.json"), JSON.stringify(spec, null, 2));
    await Bun.write(join(this.dir(id), "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  remove(id: string): void {
    rmSync(this.existingDir(id), { recursive: true, force: true });
  }

  async spec(id: string): Promise<FormSpec> {
    return parseFormSpec(await Bun.file(join(this.existingDir(id), "spec.json")).json());
  }

  async meta(id: string): Promise<AskMeta> {
    return Bun.file(join(this.existingDir(id), "meta.json")).json();
  }

  async status(id: string): Promise<AskStatus> {
    const result = Bun.file(join(this.existingDir(id), "result.json"));
    return (await result.exists()) ? result.json() : { status: "pending" };
  }

  async complete(id: string, result: FormResult): Promise<boolean> {
    const dir = this.existingDir(id);
    const staging = join(dir, `result.${process.pid}.${randomBytes(4).toString("hex")}.json`);
    await Bun.write(staging, JSON.stringify(result, null, 2));
    try {
      linkSync(staging, join(dir, "result.json"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      rmSync(staging, { force: true });
    }
  }

  async wait(id: string, timeoutMs: number, pollMs = 150): Promise<AskStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.status(id);
      if (status.status !== "pending" || Date.now() >= deadline) return status;
      await Bun.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  async pending(): Promise<AskMeta[]> {
    const metas = await Promise.all(this.ids().map((id) => this.meta(id)));
    const statuses = await Promise.all(metas.map((meta) => this.status(meta.id)));
    return metas.filter((_, index) => statuses[index]?.status === "pending");
  }

  private ids(): string[] {
    return readdirSync(this.root).filter((name) => idPattern.test(name) && existsSync(join(this.dir(name), "meta.json")));
  }

  private prune(): void {
    const cutoff = Date.now() - pruneAgeMs;
    for (const id of this.ids()) {
      if (statSync(this.dir(id)).mtimeMs < cutoff) rmSync(this.dir(id), { recursive: true, force: true });
    }
  }

  private existingDir(id: string): string {
    if (!idPattern.test(id) || !existsSync(this.dir(id))) throw new UnknownAskError(id);
    return this.dir(id);
  }

  private dir(id: string): string {
    return join(this.root, id);
  }
}

function assertPrivate(root: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const stats = statSync(root);
  if (stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new UnsafeAskRootError(`${root} must be a directory owned by you with no group or other permissions (chmod 700)`);
  }
  for (let dir = dirname(root); dir !== dirname(dir); dir = dirname(dir)) assertTrustedAncestor(dir, uid);
}

function assertTrustedAncestor(dir: string, uid: number): void {
  const stats = statSync(dir);
  const ownedByOther = stats.uid !== uid && stats.uid !== 0;
  const writableByOthers = (stats.mode & 0o002) !== 0 && (stats.mode & 0o1000) === 0;
  if (ownedByOther || writableByOthers) {
    throw new UnsafeAskRootError(`${dir} is controlled by another user, so asks stored beneath it are not private`);
  }
}
