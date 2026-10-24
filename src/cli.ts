#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { z } from "zod";
import { AlreadyAnsweredError, answer, ask, reopen } from "./ask/ask.ts";
import { HostLaunchError, hostNames, type HostName } from "./ask/hosts.ts";
import { AskStore, UnknownAskError } from "./ask/store.ts";
import { UnsafeDirectoryError } from "./private-dir.ts";
import { formSpec, parseFormSpec, type FormSpec } from "./form/schema.ts";
import { runHook } from "./hooks/hook.ts";
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
    case "hook":
      return hookCommand();
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
