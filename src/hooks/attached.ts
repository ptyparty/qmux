import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const shortestSessionPrefix = 8;

export function attachedPaneEnv(sessionId: unknown, procDir = "/proc"): Record<string, string> | undefined {
  if (typeof sessionId !== "string" || sessionId.length < shortestSessionPrefix) return undefined;
  for (const entry of safeList(procDir)) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = readNulSeparated(join(procDir, entry, "cmdline"));
    if (!argv || !attachesTo(argv, sessionId)) continue;
    const env = Object.fromEntries((readNulSeparated(join(procDir, entry, "environ")) ?? []).map(splitVariable));
    if (env.QMUX_SOCKET && env.QMUX_PANE_ID) return { QMUX_SOCKET: env.QMUX_SOCKET, QMUX_PANE_ID: env.QMUX_PANE_ID };
  }
  return undefined;
}

function attachesTo(argv: string[], sessionId: string): boolean {
  const [program, command, target] = argv;
  if (!program || basename(program) !== "claude" || command !== "attach" || !target) return false;
  return target.length >= shortestSessionPrefix && sessionId.startsWith(target);
}

function splitVariable(line: string): [string, string] {
  const index = line.indexOf("=");
  return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
}

function readNulSeparated(path: string): string[] | undefined {
  try {
    return readFileSync(path, "utf8").split("\0").filter((part) => part !== "");
  } catch {
    return undefined;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
