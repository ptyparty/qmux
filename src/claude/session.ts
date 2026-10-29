import { claudeExited } from "../hooks/hook.ts";
import type { PermissionRequest, PermissionResult } from "./permissions.ts";
import { modeArgument, nextMode, parseCommands, parseMode, permissionModes, type PermissionMode, type SlashCommand } from "./commands.ts";
import { Transcript, type StreamMessage } from "./transcript.ts";

export const claudeFlags = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-prompt-tool",
  "stdio",
];

export type SessionOptions = {
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  decide: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionResult>;
  onChange: () => void;
};

type ControlResponse = { type: "control_response"; response: { subtype: string; request_id: string; error?: string; response?: { commands?: unknown } } };

const initializeId = "qmux-initialize";

type ControlCancelRequest = { type: "control_cancel_request"; request_id: string };

type ControlRequest = { type: "control_request"; request_id: string; request: { subtype: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: PermissionRequest["permission_suggestions"] } };

export class ClaudeSession {
  readonly transcript = new Transcript();
  commands: SlashCommand[] = [];
  readonly exited: Promise<number>;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextRequest = 1;
  private readonly asking = new Map<string, AbortController>();
  private readonly modeChanges = new Map<string, { previous: string | undefined; requested: PermissionMode }>();

  constructor(private readonly options: SessionOptions) {
    this.proc = Bun.spawn(["claude", ...claudeFlags, ...options.args], {
      cwd: options.cwd,
      env: { ...options.env, QMUX_NATIVE_CLAUDE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(this.proc.stderr).text();
    void this.read();
    this.write({ type: "control_request", request_id: initializeId, request: { subtype: "initialize" } });
    this.exited = this.proc.exited.then(async (code) => {
      this.withdrawAsks();
      const detail = (await stderr).trim().split("\n").slice(-3).join("\n");
      this.transcript.ended(`Claude exited${code ? ` with code ${code}` : ""}${detail ? `: ${detail}` : ""}`);
      options.onChange();
      return code;
    });
  }

  send(text: string): void {
    const argument = modeArgument(text);
    if (argument !== undefined) return this.changeMode(argument);
    const uuid = crypto.randomUUID();
    if (this.transcript.addPrompt(text, uuid)) this.write({ type: "user", uuid, message: { role: "user", content: text } });
    this.options.onChange();
  }

  cycleMode(): void {
    this.setMode(nextMode(this.transcript.mode));
  }

  private changeMode(argument: string): void {
    const mode = parseMode(argument);
    if (mode) {
      if (this.setMode(mode)) this.transcript.notice(`Permission mode: ${mode}`);
      else this.transcript.notice("Claude has exited, so the mode wasn't changed", "error");
    } else if (argument) this.transcript.notice(`There's no "${argument}" mode; pick one of ${permissionModes.join(", ")}`, "error");
    else this.transcript.notice(`Permission mode: ${this.transcript.mode ?? "not known yet"} · /mode ${permissionModes.join("|")} changes it`);
    this.options.onChange();
  }

  private setMode(mode: PermissionMode): boolean {
    if (this.transcript.state === "ended") return false;
    const id = `qmux-${this.nextRequest++}`;
    this.modeChanges.set(id, { previous: this.transcript.mode, requested: mode });
    this.transcript.mode = mode;
    this.write({ type: "control_request", request_id: id, request: { subtype: "set_permission_mode", mode } });
    this.options.onChange();
    return true;
  }

  interrupt(): void {
    this.transcript.interrupt();
    this.write({ type: "control_request", request_id: `qmux-${this.nextRequest++}`, request: { subtype: "interrupt" } });
  }

  stop(): void {
    this.withdrawAsks();
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill();
  }

  private withdrawAsks(): void {
    for (const ask of this.asking.values()) ask.abort(claudeExited);
  }

  private write(message: unknown): void {
    if (this.transcript.state === "ended") return;
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      this.proc.stdin.flush();
    } catch {}
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handle(line);
      }
      this.options.onChange();
    }
  }

  private handle(line: string): void {
    let message: StreamMessage | ControlRequest | ControlCancelRequest | ControlResponse;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "control_request") return void this.answer(message as ControlRequest);
    if (message.type === "control_cancel_request") return void this.asking.get((message as ControlCancelRequest).request_id)?.abort();
    if (message.type === "control_response") {
      const { response } = message as ControlResponse;
      const change = this.modeChanges.get(response.request_id);
      if (change) {
        this.modeChanges.delete(response.request_id);
        if (response.subtype === "error") {
          if (this.transcript.mode === change.requested) this.transcript.mode = change.previous;
          this.transcript.notice(`Couldn't change the permission mode: ${response.error ?? "Claude refused"}`, "error");
        }
        return;
      }
      if (response.request_id === initializeId && response.subtype === "success") this.commands = parseCommands(response.response?.commands);
      return;
    }
    this.transcript.apply(message as StreamMessage);
  }

  private async answer(message: ControlRequest): Promise<void> {
    const { request } = message;
    if (request.subtype !== "can_use_tool" || !request.tool_name) {
      this.write({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: `qmux does not handle ${request.subtype}` } });
      return;
    }
    const tool = request.tool_name;
    const id = message.request_id;
    const cancel = new AbortController();
    this.asking.set(id, cancel);
    this.transcript.permissionAsked(id, tool);
    this.options.onChange();
    const result: PermissionResult = await this.options
      .decide({ tool_name: tool, input: request.input ?? {}, permission_suggestions: request.permission_suggestions }, cancel.signal)
      .catch((error: Error) => ({ behavior: "deny", message: `qmux couldn't ask the user: ${error.message}` }));
    this.asking.delete(id);
    if (cancel.signal.aborted) {
      this.transcript.permissionAnswered(id, "cancelled");
      this.options.onChange();
      return;
    }
    if (result.behavior === "allow") this.transcript.mode = grantedMode(result.updatedPermissions) ?? this.transcript.mode;
    const dismissed = result.behavior === "deny" && result.interrupt === true;
    if (dismissed) this.transcript.interrupt();
    this.transcript.permissionAnswered(id, result.behavior === "allow" ? "allowed" : dismissed ? "dismissed" : "denied");
    this.write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: result } });
    this.options.onChange();
  }
}

function grantedMode(permissions: unknown[] | undefined): string | undefined {
  const change = permissions?.findLast((permission) => (permission as { type?: unknown }).type === "setMode") as { mode?: unknown } | undefined;
  return typeof change?.mode === "string" ? change.mode : undefined;
}
