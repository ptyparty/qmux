import { closeSync, openSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServiceSpec } from "./config.ts";
import { ensurePrivateDir } from "../private-dir.ts";

export type ServiceFailure = (tabId: number, service: string, detail: string) => void;

type Running = { name: string; child: Bun.Subprocess; stopping: boolean };

const stopGraceMs = 3000;

export class TabServices {
  private readonly running = new Map<number, Running[]>();

  constructor(
    private readonly root: string,
    private readonly env: () => Record<string, string | undefined>,
    private readonly onFailure: ServiceFailure,
  ) {
    rmSync(root, { recursive: true, force: true });
  }

  tabDir(tabId: number): string {
    return ensurePrivateDir(join(this.root, String(tabId)));
  }

  start(tabId: number, services: ServiceSpec[], cwd: string | undefined): void {
    const dir = this.tabDir(tabId);
    const started = services.map((service) => {
      const name = service.name ?? basename(service.command[0]!);
      const log = openSync(join(dir, `${name}.log`), "a", 0o600);
      try {
        const child = Bun.spawn(["setsid", "setpriv", "--pdeathsig", "TERM", "--", ...service.command], {
          cwd: cwd ?? process.cwd(),
          env: { ...this.env(), QMUX_TAB_DIR: dir },
          stdin: "ignore",
          stdout: log,
          stderr: log,
        });
        const entry: Running = { name, child, stopping: false };
        child.exited.then((code) => {
          if (!entry.stopping) this.onFailure(tabId, name, `exited${code === null ? "" : ` with code ${code}`}; see ${join(dir, `${name}.log`)}`);
        });
        return entry;
      } finally {
        closeSync(log);
      }
    });
    this.running.set(tabId, [...(this.running.get(tabId) ?? []), ...started]);
  }

  stop(tabId: number): Promise<void> {
    const services = this.running.get(tabId) ?? [];
    this.running.delete(tabId);
    const dir = join(this.root, String(tabId));
    return Promise.all(services.map(stopService)).then(() => rmSync(dir, { recursive: true, force: true }));
  }

  stopAll(): Promise<void> {
    return Promise.all([...this.running.keys()].map((tabId) => this.stop(tabId))).then(() => undefined);
  }
}

function stopService(service: Running): Promise<unknown> {
  service.stopping = true;
  signalGroup(service.child.pid, "SIGTERM");
  const kill = setTimeout(() => signalGroup(service.child.pid, "SIGKILL"), stopGraceMs);
  return service.child.exited.finally(() => clearTimeout(kill));
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}
