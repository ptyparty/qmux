import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, runtimeDir } from "../private-dir.ts";
import type { FormResult } from "../form/controller.ts";
import { parseFormSpec, type FormSpec } from "../form/schema.ts";

export type AskStatus = FormResult | { status: "pending" };

export type AskOwner = { socket: string; paneId: number; server?: string };

export type AskMeta = { id: string; title: string; createdAt: string; host: string; owner?: AskOwner };

export type UnseenResult = { meta: AskMeta; result: FormResult };

const idPattern = /^[a-z0-9]+-[0-9a-f]{8}$/;
const pruneAgeMs = 24 * 60 * 60 * 1000;

export class UnknownAskError extends Error {
  constructor(id: string) {
    super(`no ask with id ${id}`);
  }
}

export function defaultAskRoot(): string {
  return join(runtimeDir(), "asks");
}

export class AskStore {
  constructor(readonly root: string = defaultAskRoot()) {
    ensurePrivateDir(root);
  }

  async create(spec: FormSpec, host: string, owner?: AskOwner): Promise<AskMeta> {
    this.prune();
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const meta: AskMeta = { id, title: spec.title, createdAt: new Date().toISOString(), host, ...(owner && { owner }) };
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
      if (status.status !== "pending") {
        this.claim(id);
        return status;
      }
      if (Date.now() >= deadline) return status;
      await Bun.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  async pending(owner?: AskOwner): Promise<AskMeta[]> {
    const asks = await this.existing(owner && ((meta) => sameOwner(meta.owner, owner)));
    return asks.filter((entry) => entry.status.status === "pending").map((entry) => entry.meta);
  }

  async claimUnseen(owner: AskOwner): Promise<UnseenResult[]> {
    const unseen: UnseenResult[] = [];
    for (const { meta, status } of await this.existing((meta) => sameOwner(meta.owner, owner))) {
      if (status.status !== "pending" && this.claim(meta.id)) unseen.push({ meta, result: status });
    }
    return unseen.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
  }

  private async existing(wanted: (meta: AskMeta) => boolean = () => true): Promise<{ meta: AskMeta; status: AskStatus }[]> {
    const found = await Promise.all(
      this.ids().map(async (id) => {
        try {
          const meta = await this.meta(id);
          return wanted(meta) ? { meta, status: await this.status(id) } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return found.filter((entry) => entry !== undefined);
  }

  private claim(id: string): boolean {
    try {
      closeSync(openSync(join(this.dir(id), "seen"), "wx"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT") return false;
      throw error;
    }
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

function sameOwner(a: AskOwner | undefined, b: AskOwner): boolean {
  return a !== undefined && a.socket === b.socket && a.paneId === b.paneId && a.server === b.server;
}
