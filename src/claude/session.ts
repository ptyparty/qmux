import { filterEscalatingDefaultMode, query, resolveSettings, type PermissionResult as SdkPermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeExited } from "../hooks/hook.ts";
import type { PermissionRequest, PermissionResult } from "./permissions.ts";
import { modeArgument, nextMode, parseCommands, parseMode, permissionModes, type PermissionMode, type SlashCommand } from "./commands.ts";
import { claudeOptions } from "./options.ts";
import { Transcript, type StreamMessage } from "./transcript.ts";

export type SessionOptions = {
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  decide: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionResult>;
  onChange: () => void;
  onInterrupted: () => void;
};

export class ClaudeSession {
  readonly transcript = new Transcript();
  commands: SlashCommand[] = [];
  readonly exited: Promise<number>;
  private readonly query: Query;
  private readonly prompts = new MessageQueue<SDKUserMessage>();
  private readonly asking = new Set<AbortController>();
  private stderr: string[] = [];
  private stopping = false;
  private interrupted = false;

  constructor(private readonly options: SessionOptions) {
    const parsed = claudeOptions(options.args);
    this.query = query({
      prompt: this.prompts,
      options: {
        ...parsed,
        cwd: options.cwd,
        env: { ...options.env, QMUX_NATIVE_CLAUDE: "1" },
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        canUseTool: (tool, input, { signal, suggestions, toolUseID }) => this.answer(tool, input, suggestions, toolUseID, signal),
        stderr: (data) => (this.stderr = [...this.stderr, ...data.split("\n").filter((line) => line.trim())].slice(-3)),
      },
    });
    this.transcript.mode = parsed.permissionMode;
    if (!parsed.permissionMode)
      resolveSettings({ cwd: options.cwd }).then(
        (resolved) => {
          this.transcript.mode ??= parseMode(filterEscalatingDefaultMode(resolved).permissions?.defaultMode ?? "") ?? "default";
          options.onChange();
        },
        () => {},
      );
    this.query.supportedCommands().then(
      (commands) => {
        this.commands = parseCommands(commands);
        options.onChange();
      },
      () => {},
    );
    this.exited = this.read().then(
      () => this.finish(0),
      (error: Error) => this.finish(1, error.message),
    );
  }

  send(text: string): void {
    const argument = modeArgument(text);
    if (argument !== undefined) return this.changeMode(argument);
    const uuid = crypto.randomUUID();
    if (this.transcript.addPrompt(text, uuid)) this.prompts.push({ type: "user", uuid, session_id: "", parent_tool_use_id: null, message: { role: "user", content: text } });
    this.options.onChange();
  }

  cycleMode(): void {
    this.setMode(nextMode(this.transcript.mode));
  }

  interrupt(): void {
    this.interrupted = true;
    this.transcript.interrupt();
    this.query.interrupt().catch(() => {});
  }

  stop(): void {
    this.stopping = true;
    this.withdrawAsks();
    this.prompts.close();
    this.query.close();
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
    const previous = this.transcript.mode;
    this.transcript.mode = mode;
    this.query.setPermissionMode(mode).catch((error: Error) => {
      if (this.transcript.mode === mode) this.transcript.mode = previous;
      this.transcript.notice(`Couldn't change the permission mode: ${error.message}`, "error");
      this.options.onChange();
    });
    this.options.onChange();
    return true;
  }

  private withdrawAsks(): void {
    for (const ask of this.asking) ask.abort(claudeExited);
  }

  private async read(): Promise<void> {
    for await (const message of this.query) {
      this.transcript.apply(message as unknown as StreamMessage);
      if (message.type === "result" && this.interrupted) {
        this.interrupted = false;
        this.options.onInterrupted();
      }
      this.options.onChange();
    }
  }

  private finish(code: number, error?: string): number {
    this.withdrawAsks();
    this.prompts.close();
    if (this.stopping) return code;
    const detail = [error, ...this.stderr].filter(Boolean).join("\n");
    this.transcript.ended(`Claude exited${detail ? `: ${detail}` : ""}`);
    this.options.onChange();
    return code;
  }

  private async answer(tool: string, input: Record<string, unknown>, suggestions: unknown[] | undefined, id: string, withdrawn: AbortSignal): Promise<SdkPermissionResult> {
    const ask = new AbortController();
    const signal = AbortSignal.any([withdrawn, ask.signal]);
    this.asking.add(ask);
    this.transcript.permissionAsked(id, tool);
    this.options.onChange();
    const result: PermissionResult = await this.options
      .decide({ tool_name: tool, input, permission_suggestions: suggestions as PermissionRequest["permission_suggestions"] }, signal)
      .catch((error: Error) => ({ behavior: "deny", message: `qmux couldn't ask the user: ${error.message}` }));
    this.asking.delete(ask);
    if (signal.aborted) {
      this.transcript.permissionAnswered(id, "cancelled");
      this.options.onChange();
      return { behavior: "deny", message: "Withdrawn" };
    }
    if (result.behavior === "allow") this.transcript.mode = grantedMode(result.updatedPermissions) ?? this.transcript.mode;
    const dismissed = result.behavior === "deny" && result.interrupt === true;
    if (dismissed) this.transcript.interrupt();
    this.transcript.permissionAnswered(id, result.behavior === "allow" ? "allowed" : dismissed ? "dismissed" : "denied");
    this.options.onChange();
    return result as SdkPermissionResult;
  }
}

class MessageQueue<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.queued.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.queued.length > 0) yield this.queued.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

function grantedMode(permissions: unknown[] | undefined): string | undefined {
  const change = permissions?.findLast((permission) => (permission as { type?: unknown }).type === "setMode") as { mode?: unknown } | undefined;
  return typeof change?.mode === "string" ? change.mode : undefined;
}
