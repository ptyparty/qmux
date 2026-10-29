#!/usr/bin/env bun
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AlreadyAnsweredError, answer, ask, reopen } from "./ask/ask.ts";
import { HostLaunchError, hostNames, type HostName } from "./ask/hosts.ts";
import { AskStore, UnknownAskError } from "./ask/store.ts";
import { UnsafeDirectoryError } from "./private-dir.ts";
import { formSpec, parseFormSpec, type FormSpec } from "./form/schema.ts";
import { runHook, waitForAnswers } from "./hooks/hook.ts";
import { sendControl } from "./mux/control.ts";
import { defaultSessionName, listSessions, quitSession, SessionError } from "./mux/session/sessions.ts";

const usage = `qmux: a terminal multiplexer agents can drive

Usage:
  qmux [attach [NAME]]
      Attach to session NAME (default "main"), starting it if it is not running.
      Detach with Ctrl+o d; the session keeps running.
  qmux ls
      List running sessions.
  qmux kill NAME
      End a session and every program running in it.
  qmux project NAME|PATH
      From inside a session, open a project in a new tab, or switch to its tab if it is open.
  qmux pane open [--right|--below|--tab|--popup] [--name NAME] [--no-focus] [--width PCT] [--height PCT] -- COMMAND...
      From inside a session, open a pane running COMMAND beside this one, or over this tab with --popup.
      A popup closes when COMMAND succeeds; --width and --height size it. Prints the new pane's id.
  qmux claude [--resume ID|--continue] [--mode MODE] [-- CLAUDE_ARGS...]
      Run a Claude Code session in this pane with qmux drawing the conversation (experimental).
      From anywhere else in the tab, Alt+c sends it a message.
      --mode starts it in default, acceptEdits, plan or auto mode; /mode or Shift+Tab changes it later.
  qmux job run [--name NAME] [--wait] -- COMMAND...
      From inside a session, run COMMAND out of sight as a job in this tab; a toast says when it is done.
      Prints the job's id. With --wait, print the job's output as it runs and exit with its exit code.
  qmux ask [spec.json|-] [--wait] [--timeout SECONDS] [--host auto|qmux|zellij|tmux|none]
      Open a form for the user and print {"id", "host", "message", "status", ...}.
      With --wait, block until the user answers (or the timeout passes).
  qmux wait ID [--timeout SECONDS]
      Print the ask's result, waiting for it if necessary. Without --timeout, waits forever.
  qmux open ID [--host ...]
      Show a pending ask's form, for example when no host was detected when it was asked.
  qmux pending
      List asks that have not been answered.
  qmux form spec.json
      Show a form in this terminal and print the result.
  qmux form --ask ID [--asks-dir DIR]
      Show a stored ask's form in this terminal and record the answer.
      Closing the form records a cancel.
  qmux schema
      Print the JSON Schema for form specs.
  qmux mcp
      Run the MCP server on stdio.
  qmux hook
      Claude Code hook: reads the hook's JSON on stdin and reports the agent's state to qmux.
      Permission requests become a popup in the agent's tab. Does nothing outside qmux.
  qmux peek spec.json --pane ID
      Show an agent's reply (what Alt p opens); a typed reply is sent to pane ID.
  qmux hooks [--install]
      List the Claude Code hooks qmux needs that are missing from your settings, or add them.
  qmux hook --wake
      Claude Code Stop hook to run with asyncRewake: waits until a form this pane opened is answered
      or dismissed, then exits 2 with the answer so Claude wakes up and reads it.

Results are JSON: {"status":"submitted","values":{...}}, {"status":"cancelled"}, or {"status":"pending"}.`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "ask":
      return askCommand(rest);
    case "wait":
      return waitCommand(rest);
    case "open":
      return openCommand(rest);
    case "pending":
      return print(await new AskStore().pending());
    case "form":
      return formCommand(rest);
    case "schema":
      return print(z.toJSONSchema(formSpec));
    case "mcp":
      return (await import("./mcp/server.ts")).serveStdio();
    case "peek":
      return peekCommand(rest);
    case "hooks":
      return hooksCommand(rest);
    case "hook":
      return rest[0] === "--wake" ? wakeCommand() : hookCommand();
    case undefined:
      return (await import("./mux/session/client.ts")).attachSession(defaultSessionName);
    case "attach":
      return (await import("./mux/session/client.ts")).attachSession(rest[0] ?? defaultSessionName);
    case "ls":
      return listCommand();
    case "kill":
      return quitSession(requireName(rest));
    case "project":
      return projectCommand(rest);
    case "pane":
      return paneCommand(rest);
    case "job":
      return jobCommand(rest);
    case "claude":
      return claudeCommand(rest);
    case "server":
      return (await import("./mux/session/server.ts")).runServer(requireName(rest));
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      return;
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

async function askCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    host: { type: "string", default: "auto" },
  });
  const spec = await readSpec(positionals[0] ?? "-");
  const waitMs = values.wait ? timeoutMs(values.timeout) : 0;
  const outcome = await ask(new AskStore(), spec, hostOption(values.host), waitMs);
  print({ id: outcome.id, host: outcome.launch.host, message: outcome.launch.message, ...outcome.status });
}

async function waitCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { timeout: { type: "string" } });
  const id = requireId(positionals);
  print({ id, ...(await new AskStore().wait(id, timeoutMs(values.timeout))) });
}

async function openCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { host: { type: "string", default: "auto" } });
  const id = requireId(positionals);
  const launch = await reopen(new AskStore(), id, hostOption(values.host));
  print({ id, host: launch.host, message: launch.message });
}

async function formCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { ask: { type: "string" }, "asks-dir": { type: "string" } });
  if (values.ask !== undefined) {
    await answer(new AskStore(values["asks-dir"]), values.ask);
    return;
  }
  const [source] = positionals;
  if (source === undefined || source === "-") {
    throw new UsageError("qmux form needs a spec file; stdin is reserved for the keyboard");
  }
  print(await (await import("./form/show.ts")).showForm(await readSpec(source), async () => {}));
}

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function readSpec(source: string): Promise<FormSpec> {
  const text = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`form spec is not valid JSON: ${(error as Error).message}`);
  }
  return parseFormSpec(json);
}

function timeoutMs(seconds: string | undefined): number {
  if (seconds === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--timeout must be a number of seconds, got ${seconds}`);
  return parsed * 1000;
}

function hostOption(host: string | boolean | undefined): HostName {
  if (!hostNames.includes(host as HostName)) throw new UsageError(`--host must be one of ${hostNames.join(", ")}`);
  return host as HostName;
}

function requireId(positionals: string[]): string {
  const [id] = positionals;
  if (!id) throw new UsageError("missing ask id");
  return id;
}

async function hookCommand(): Promise<void> {
  try {
    const output = await runHook(await Bun.stdin.text(), process.env);
    if (output) console.log(output);
  } catch (error) {
    console.error(`qmux hook: ${(error as Error).message}`);
  }
  process.exit(0);
}

async function peekCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { pane: { type: "string" } });
  const [source] = positionals;
  if (!source) throw new UsageError("qmux peek needs a spec file");
  const result = await (await import("./form/show.ts")).showForm(await readSpec(source), async () => {});
  const paneId = Number(values.pane);
  const socket = process.env.QMUX_SOCKET;
  const text = result.status === "submitted" && typeof result.values.reply === "string" ? result.values.reply.trim() : "";
  if (!text || !socket || !Number.isInteger(paneId)) return;
  await sendControl(socket, { method: "agent.prompt", params: { paneId, text } }).catch(() => undefined);
}

async function hooksCommand(args: string[]): Promise<void> {
  const { values } = parse(args, { install: { type: "boolean" } });
  const setup = await import("./claude/hooks-setup.ts");
  const { user: path, local: localPath } = setup.settingsPaths();
  const [settings, local] = await Promise.all([setup.readSettings(path), setup.readSettings(localPath)]);
  const missing = setup.missingHooks([settings, local]);
  if (missing.length === 0) return console.log(`qmux hooks are up to date in ${path}`);
  if (!values.install) {
    console.log(`Missing or out of date in ${path}:`);
    for (const hook of missing) console.log(`  ${hook.label}: ${hook.why}`);
    return console.log("Run `qmux hooks --install` to add them.");
  }
  const backup = await setup.writeSettings(path, setup.installHooks(settings, [local], setup.defaultHookCommand()));
  console.log(`Installed ${missing.length} qmux hooks in ${path}${backup ? `; the old file is at ${backup}` : ""}`);
}

async function wakeCommand(): Promise<void> {
  let input = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {}
  const notice = await waitForAnswers(process.env, input).catch(() => undefined);
  if (!notice) process.exit(0);
  console.error(notice);
  process.exit(2);
}

async function projectCommand(args: string[]): Promise<void> {
  const [target] = args;
  if (!target) throw new UsageError("missing project name or path");
  const socket = process.env.QMUX_SOCKET;
  if (!socket) throw new UsageError("qmux project works from inside a qmux session");
  const response = await sendControl(socket, { method: "project.open", params: { target } }).catch((error: Error) => {
    throw new SessionError(error.message);
  });
  if (!response.ok) throw new SessionError(response.error);
}

async function paneCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "open") throw new UsageError(`unknown pane command ${subcommand ?? ""}`.trim());
  const { values, positionals } = parse(rest, {
    right: { type: "boolean" },
    below: { type: "boolean" },
    tab: { type: "boolean" },
    popup: { type: "boolean" },
    width: { type: "string" },
    height: { type: "string" },
    name: { type: "string" },
    "no-focus": { type: "boolean" },
  });
  const placements = (["right", "below", "tab", "popup"] as const).filter((placement) => values[placement]);
  if (placements.length > 1) throw new UsageError("pick one of --right, --below, --tab, and --popup");
  const width = percent(values.width, "--width");
  const height = percent(values.height, "--height");
  if (positionals.length === 0) throw new UsageError("missing the command to run in the pane");
  const socket = process.env.QMUX_SOCKET;
  const near = Number(process.env.QMUX_PANE_ID);
  if (!socket || !Number.isInteger(near)) throw new UsageError("qmux pane open works from inside a qmux pane");
  const response = await sendControl(socket, {
    method: "pane.open",
    params: { command: positionals, near, placement: placements[0] ?? "right", name: values.name, focus: !values["no-focus"], width, height },
  }).catch((error: Error) => {
    throw new SessionError(error.message);
  });
  if (!response.ok) throw new SessionError(response.error);
  console.log((response.result as { paneId: number }).paneId);
}

async function claudeCommand(args: string[]): Promise<void> {
  const { runClaude, runCompose } = await import("./claude/run.ts");
  if (args[0] === "compose") {
    const { values } = parse(args.slice(1), { socket: { type: "string" }, name: { type: "string" } });
    if (!values.socket) throw new UsageError("missing --socket");
    return runCompose(values.socket, values.name ?? "Claude");
  }
  const { values, positionals } = parse(args, { resume: { type: "string" }, continue: { type: "boolean" }, mode: { type: "string" } });
  if (values.resume && values.continue) throw new UsageError("pick one of --resume and --continue");
  const { parseMode, permissionModes } = await import("./claude/commands.ts");
  const mode = values.mode === undefined ? undefined : parseMode(values.mode);
  if (values.mode !== undefined && !mode) throw new UsageError(`--mode must be one of ${permissionModes.join(", ")}`);
  const picksItself = ["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--from-pr"];
  const pick = !values.resume && !values.continue && !positionals.some((arg) => picksItself.includes(arg.split("=")[0]!));
  const claudeArgs = [...(values.resume ? ["--resume", values.resume] : []), ...(values.continue ? ["--continue"] : []), ...(mode ? ["--permission-mode", mode] : []), ...positionals];
  const { claudeOptions } = await import("./claude/options.ts");
  try {
    claudeOptions(claudeArgs);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return runClaude(
    claudeArgs,
    { pick },
  );
}

async function jobCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "run") throw new UsageError(`unknown job command ${subcommand ?? ""}`.trim());
  const { values, positionals } = parse(rest, { name: { type: "string" }, wait: { type: "boolean" } });
  if (positionals.length === 0) throw new UsageError("missing the command to run as a job");
  const socket = process.env.QMUX_SOCKET;
  const near = Number(process.env.QMUX_PANE_ID);
  if (!socket || !Number.isInteger(near)) throw new UsageError("qmux job run works from inside a qmux pane");
  const control = async (request: Parameters<typeof sendControl>[1]) => {
    const response = await sendControl(socket, request).catch((error: Error) => {
      throw new SessionError(error.message);
    });
    if (!response.ok) throw new SessionError(response.error);
    return response.result;
  };
  const { jobId, log } = (await control({ method: "job.run", params: { command: positionals, near, name: values.name, cwd: process.cwd(), env: definedEnv() } })) as { jobId: number; log: string };
  if (!values.wait) {
    console.log(jobId);
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      void sendControl(socket, { method: "job.stop", params: { jobId } }).finally(() => process.exit(128 + constants.signals[signal]));
    });
  }
  const output = new JobOutput(log);
  for (;;) {
    const status = (await control({ method: "job.status", params: { jobId } })) as { state: string; code: number | null };
    const finished = status.state !== "running";
    if (finished) await Bun.sleep(300);
    await output.drain(finished);
    if (finished) process.exit(status.code ?? 1);
    await Bun.sleep(300);
  }
}

function definedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

class JobOutput {
  private offset = 0;
  private pending = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly path: string) {}

  async drain(final: boolean): Promise<void> {
    const file = Bun.file(this.path);
    const bytes = await file.slice(this.offset).bytes();
    this.offset += bytes.length;
    const text = this.pending + this.decoder.decode(bytes, { stream: !final });
    const end = final ? text.length : text.lastIndexOf("\n") + 1;
    this.pending = text.slice(end);
    const lines = Bun.stripANSI(text.slice(0, end)).replace(/\r\n/g, "\n").split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1));
    const printable = lines.join("\n");
    if (printable !== "") process.stdout.write(final && !printable.endsWith("\n") ? `${printable}\n` : printable);
  }
}

function percent(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value.replace(/%$/, ""));
  if (!Number.isFinite(number) || number < 10 || number > 100) throw new UsageError(`${flag} takes a percentage from 10 to 100`);
  return number;
}

async function listCommand(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log("No running sessions. Start one with: qmux attach NAME");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.session}  ${session.tabs} tab(s), ${session.panes} pane(s)${session.attached > 0 ? `  (${session.attached} attached)` : ""}`);
  }
}

function requireName(args: string[]): string {
  const [name] = args;
  if (!name) throw new UsageError("missing session name");
  return name;
}

function isReportable(error: unknown): error is Error {
  return [UnknownAskError, HostLaunchError, AlreadyAnsweredError, UnsafeDirectoryError, SessionError].some((type) => error instanceof type);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof z.ZodError) console.error(`invalid form spec:\n${z.prettifyError(error)}`);
  else if (error instanceof UsageError) console.error(`${error.message}\n\n${usage}`);
  else if (isReportable(error)) console.error(error.message);
  else throw error;
  process.exit(1);
}
