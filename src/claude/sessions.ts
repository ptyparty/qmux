import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PastSession = { sessionId: string; title?: string; lastPrompt?: string; modified: number };
export type RunningSession = { sessionId: string; name?: string; kind: string };
export type LiveSession = { paneId: number; sessionId: string; tab: string };

export type Choice =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string }
  | { kind: "focus"; paneId: number; sessionId: string }
  | { kind: "skip" };

export type PickerItem = { label: string; detail: string; choice: Choice };

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectDir(cwd: string, configDir = claudeConfigDir()): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function sessionIds(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

const tailBytes = 512 * 1024;

export async function pastSessions(dir: string, limit: number): Promise<PastSession[]> {
  const recent = sessionIds(dir)
    .flatMap((sessionId) => {
      try {
        return [{ sessionId, modified: statSync(join(dir, `${sessionId}.jsonl`)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
  return Promise.all(recent.map(async (session) => ({ ...session, ...describe(await readTail(join(dir, `${session.sessionId}.jsonl`))) })));
}

async function readTail(path: string): Promise<string> {
  const file = Bun.file(path);
  return file.slice(Math.max(file.size - tailBytes, 0)).text();
}

export function describe(text: string): { title?: string; lastPrompt?: string } {
  let title: string | undefined;
  let custom: string | undefined;
  let lastPrompt: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"') && !line.includes('"type":"last-prompt"')) continue;
    let entry: { type?: string; aiTitle?: unknown; customTitle?: unknown; lastPrompt?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") title = entry.aiTitle;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") custom = entry.customTitle;
    if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string") lastPrompt = entry.lastPrompt;
  }
  return { title: custom ?? title, lastPrompt };
}

export async function runningSessions(cwd: string, timeoutMs = 2000): Promise<RunningSession[]> {
  const proc = Bun.spawn(["claude", "agents", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const listed = JSON.parse(await new Response(proc.stdout).text()) as { cwd?: string; kind?: string; sessionId?: string; name?: string }[];
    return listed.flatMap((agent) => (agent.cwd === cwd && agent.kind === "interactive" && agent.sessionId ? [{ sessionId: agent.sessionId, name: agent.name, kind: agent.kind }] : []));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function pickerItems(input: { live: LiveSession[]; running: RunningSession[]; past: PastSession[]; known: string[]; now: number; asJob?: boolean }): PickerItem[] {
  const known = new Set(input.known);
  const past = new Map(input.past.map((session) => [session.sessionId, session]));
  const title = (sessionId: string, fallback?: string) => past.get(sessionId)?.title ?? fallback ?? sessionId.slice(0, 8);
  const listed = new Set<string>();
  const items: PickerItem[] = [];
  for (const session of input.live.filter((live) => known.has(live.sessionId))) {
    listed.add(session.sessionId);
    items.push({ label: title(session.sessionId), detail: `open in ${session.tab} · go there`, choice: { kind: "focus", paneId: session.paneId, sessionId: session.sessionId } });
  }
  for (const session of input.running.filter((running) => !listed.has(running.sessionId))) {
    listed.add(session.sessionId);
    items.push({ label: title(session.sessionId, session.name), detail: "running in another terminal · open here too", choice: { kind: "resume", sessionId: session.sessionId } });
  }
  items.push({ label: "New conversation", detail: "start fresh", choice: { kind: "new" } });
  if (input.asJob) items.push({ label: "Don't start Claude", detail: "close this job · ^s s starts it again", choice: { kind: "skip" } });
  for (const session of input.past.filter((past) => !listed.has(past.sessionId))) {
    const prompt = session.lastPrompt ? ` · › ${oneLine(session.lastPrompt, 100)}` : "";
    items.push({ label: title(session.sessionId), detail: `${age(input.now - session.modified)}${prompt}`, choice: { kind: "resume", sessionId: session.sessionId } });
  }
  return items;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
