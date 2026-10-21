#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { z } from "zod";
import { AlreadyAnsweredError, answer, ask, reopen } from "./ask/ask.ts";
import { HostLaunchError, hostNames, type HostName } from "./ask/hosts.ts";
import { AskStore, UnknownAskError } from "./ask/store.ts";
import { UnsafeDirectoryError } from "./private-dir.ts";
import { formSpec, parseFormSpec, type FormSpec } from "./form/schema.ts";
import { showForm } from "./form/show.ts";
import { serveStdio } from "./mcp/server.ts";
import { runMux } from "./mux/app.ts";

const usage = `qmux: a terminal multiplexer agents can drive

Usage:
  qmux
      Start the multiplexer in this terminal.
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
      return serveStdio();
    case undefined:
      return runMux();
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
  print(await showForm(await readSpec(source), async () => {}));
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

function isReportable(error: unknown): error is Error {
  return [UnknownAskError, HostLaunchError, AlreadyAnsweredError, UnsafeDirectoryError].some((type) => error instanceof type);
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
