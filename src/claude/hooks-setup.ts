import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selfCommand, shellQuote, shellWords } from "../ask/hosts.ts";
import { claudeConfigDir } from "./sessions.ts";

type HookCommand = { type: string; command?: string; timeout?: number; async?: boolean; asyncRewake?: boolean; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [key: string]: unknown };
export type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

type Wanted = { event: string; tools?: string[]; star?: boolean; wake?: boolean; timeout: number; why: string };
type Found = { group: HookGroup; hook: HookCommand };

const longTimeout = 3600;

const wanted: Wanted[] = [
  { event: "UserPromptSubmit", timeout: 10, why: "working badge, and answers to forms you closed" },
  { event: "Stop", timeout: 10, why: "done badge and the last reply" },
  { event: "Stop", wake: true, timeout: 86400, why: "wake Claude when you answer a form it left open" },
  { event: "Notification", star: true, timeout: 10, why: "needs-you badge and notifications" },
  { event: "PermissionRequest", star: true, timeout: 3600, why: "permission popups" },
  { event: "PreToolUse", tools: ["AskUserQuestion", "Bash"], timeout: 3600, why: "question popups, and background commands as jobs" },
  { event: "SessionStart", timeout: 5, why: "know which conversation each pane holds" },
  { event: "SessionEnd", timeout: 5, why: "clear a pane's badge when Claude exits" },
];

export type Problem = { label: string; why: string; upgrade: boolean };

export function settingsPaths(configDir = claudeConfigDir()): { user: string; local: string } {
  return { user: join(configDir, "settings.json"), local: join(configDir, "settings.local.json") };
}

export function defaultHookCommand(): string {
  return shellQuote([...selfCommand(), "hook"]);
}

function isQmuxHook(command: string | undefined, wake: boolean): boolean {
  if (!command) return false;
  const words = shellWords(command);
  const at = words.lastIndexOf("hook");
  if (at < 1 || !/(^|\/)(qmux|cli\.ts)$/.test(words[at - 1]!)) return false;
  return wake ? words[at + 1] === "--wake" && words.length === at + 2 : words.length === at + 1;
}

function matchesAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === "" || matcher === "*" || matcher === ".*";
}

function matchesTool(matcher: string | undefined, tool: string): boolean {
  if (matchesAll(matcher)) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher!.split("|").includes(tool);
  }
}

function covers(matcher: string | undefined, want: Wanted): boolean {
  return want.tools ? want.tools.every((tool) => matchesTool(matcher, tool)) : matchesAll(matcher);
}

function findHook(settings: Settings, want: Wanted): Found | undefined {
  let partial: Found | undefined;
  for (const group of settings.hooks?.[want.event] ?? []) {
    const hook = group.hooks?.find((candidate) => candidate.type === "command" && isQmuxHook(candidate.command, Boolean(want.wake)));
    if (!hook) continue;
    if (covers(group.matcher, want)) return { group, hook };
    partial ??= { group, hook };
  }
  return partial;
}

function problem(want: Wanted, found: Found | undefined): Problem | undefined {
  const label = `${want.event}${want.wake ? " (wake)" : ""}${want.tools ? ` [${want.tools.join("|")}]` : ""}`;
  const upgrade = (detail: string) => ({ label: `${label}: ${detail}`, why: want.why, upgrade: true });
  if (!found) return { label, why: want.why, upgrade: false };
  if (!covers(found.group.matcher, want)) return upgrade("widen matcher");
  if (want.wake && !(found.hook.async && found.hook.asyncRewake)) return upgrade("run async with asyncRewake");
  if (want.timeout >= longTimeout && (found.hook.timeout ?? 0) < want.timeout) return upgrade(`raise timeout to ${want.timeout}s`);
  return undefined;
}

export function missingHooks(sources: Settings[]): Problem[] {
  return wanted.flatMap((want) => {
    const problems = sources.map((settings) => problem(want, findHook(settings, want)));
    if (problems.some((found) => found === undefined)) return [];
    return [problems.find((found) => found!.upgrade) ?? problems[0]!];
  });
}

export function installHooks(target: Settings, others: Settings[], fallbackCommand: string): Settings {
  const existing = [target, ...others]
    .flatMap((settings) => Object.values(settings.hooks ?? {}).flat())
    .flatMap((group) => group.hooks ?? [])
    .find((hook) => isQmuxHook(hook.command, false))?.command;
  const command = existing ?? fallbackCommand;
  const hooks: Record<string, HookGroup[]> = structuredClone(target.hooks ?? {});
  for (const want of wanted) {
    if (others.some((settings) => !problem(want, findHook(settings, want)))) continue;
    const groups = (hooks[want.event] ??= []);
    const found = findHook({ hooks }, want);
    if (found && !problem(want, found)) continue;
    if (found) {
      found.group.hooks = found.group.hooks!.filter((hook) => hook !== found.hook);
      if (found.group.hooks.length === 0) groups.splice(groups.indexOf(found.group), 1);
    }
    const hook: HookCommand = {
      ...found?.hook,
      type: "command",
      command: found?.hook.command ?? (want.wake ? `${command} --wake` : command),
      timeout: Math.max(found?.hook.timeout ?? 0, want.timeout),
      ...(want.wake && { async: true, asyncRewake: true }),
    };
    const matcher = want.tools ? want.tools.join("|") : want.star ? "*" : undefined;
    groups.push({ ...(matcher && { matcher }), hooks: [hook] });
  }
  return { ...target, hooks };
}

export async function readSettings(path: string): Promise<Settings> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as Settings) : {};
}

export async function writeSettings(path: string, settings: Settings): Promise<string | undefined> {
  let backup: string | undefined;
  if (await Bun.file(path).exists()) {
    backup = existsSync(`${path}.qmux-backup`) ? `${path}.qmux-backup-${Date.now()}` : `${path}.qmux-backup`;
    await Bun.write(backup, Bun.file(path));
  }
  const staging = `${path}.qmux-${process.pid}`;
  await Bun.write(staging, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(staging, path);
  return backup;
}

export function declinedPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "qmux", "hooks-declined");
}

export function hooksDeclined(): Promise<boolean> {
  return Bun.file(declinedPath()).exists();
}

export async function declineHooks(): Promise<void> {
  await Bun.write(declinedPath(), "");
}
