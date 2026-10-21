import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { selfCommand } from "../../ask/hosts.ts";
import { ensurePrivateDir, runtimeDir } from "../../private-dir.ts";
import { ControlError, sendControl } from "../control.ts";

export const defaultSessionName = "main";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const startTimeoutMs = 5000;

export class SessionError extends Error {}

export type SessionPaths = { client: string; control: string; log: string };

export type SessionInfo = { session: string; tabs: number; panes: number; attached: boolean };

export function sessionPaths(name: string): SessionPaths {
  if (!namePattern.test(name)) {
    throw new SessionError(`session names use letters, digits, ".", "_", and "-", and start with a letter or digit; got ${JSON.stringify(name)}`);
  }
  const dir = ensurePrivateDir(join(runtimeDir(), "sessions"));
  return { client: join(dir, `${name}.sock`), control: join(dir, `${name}.control.sock`), log: join(dir, `${name}.log`) };
}

export async function sessionInfo(name: string): Promise<SessionInfo | undefined> {
  const { control } = sessionPaths(name);
  if (!existsSync(control)) return undefined;
  try {
    const response = await sendControl(control, { method: "session.info" }, 1000);
    return response.ok ? (response.result as SessionInfo) : undefined;
  } catch (error) {
    if (error instanceof ControlError) return undefined;
    throw error;
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const dir = ensurePrivateDir(join(runtimeDir(), "sessions"));
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".control.sock"))
    .map((file) => file.slice(0, -".control.sock".length));
  const infos = await Promise.all(names.map(sessionInfo));
  return infos.filter((info): info is SessionInfo => info !== undefined);
}

export async function quitSession(name: string): Promise<void> {
  const response = await sendControl(sessionPaths(name).control, { method: "session.quit" }).catch((error: Error) => {
    throw new SessionError(`no running session named ${name}: ${error.message}`);
  });
  if (!response.ok) throw new SessionError(response.error);
}

export async function startServer(name: string): Promise<void> {
  const paths = sessionPaths(name);
  const log = openSync(paths.log, "a", 0o600);
  Bun.spawn(["setsid", ...selfCommand(), "server", name], { stdio: ["ignore", log, log], detached: true }).unref();
  closeSync(log);
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (await sessionInfo(name)) return;
    await Bun.sleep(50);
  }
  throw new SessionError(`session ${name} did not start; see ${paths.log}`);
}
