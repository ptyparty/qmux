import type { PermissionRequest, PermissionResult } from "./permissions.ts";
import { parseCommands, type SlashCommand } from "./commands.ts";
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

type ControlResponse = { type: "control_response"; response: { subtype: string; request_id: string; response?: { commands?: unknown } } };

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
    const uuid = crypto.randomUUID();
    if (this.transcript.addPrompt(text, uuid)) this.write({ type: "user", uuid, message: { role: "user", content: text } });
    this.options.onChange();
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
    for (const ask of this.asking.values()) ask.abort();
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
    const dismissed = result.behavior === "deny" && result.interrupt === true;
    if (dismissed) this.transcript.interrupt();
    this.transcript.permissionAnswered(id, result.behavior === "allow" ? "allowed" : dismissed ? "dismissed" : "denied");
    this.write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: result } });
    this.options.onChange();
  }
}
