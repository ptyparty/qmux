import { summarizeToolInput } from "../hooks/hook.ts";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error" }
  | { kind: "notice"; text: string; tone: "info" | "warning" | "error" };

export type SessionState = "idle" | "working" | "waiting" | "ended";

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };

export type StreamMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  isReplay?: boolean;
  isSynthetic?: boolean;
  message?: { content?: string | Block[] };
  event?: { type: string; content_block?: Block; delta?: { type: string; text?: string } };
  total_cost_usd?: number;
  is_error?: boolean;
  result?: string;
  request?: { subtype: string; tool_name?: string; input?: Record<string, unknown> };
};

export class Transcript {
  readonly entries: Entry[] = [];
  state: SessionState = "idle";
  sessionId: string | undefined;
  model: string | undefined;
  cost = 0;
  private streaming: Entry & { kind: "text" } | undefined;
  private interrupting = false;
  private readonly pending = new Set<string>();
  private readonly changed = new Set<Entry>();

  takeChanges(): Entry[] {
    const changes = [...this.changed];
    this.changed.clear();
    return changes;
  }

  interrupt(): void {
    this.interrupting = true;
  }

  addPrompt(text: string, uuid?: string): boolean {
    if (this.state === "ended") {
      this.notice("Claude has exited, so this message wasn't sent", "error");
      return false;
    }
    this.add({ kind: "user", text });
    if (uuid) this.pending.add(uuid);
    if (this.state !== "waiting") this.state = "working";
    return true;
  }

  notice(text: string, tone: "info" | "warning" | "error" = "info"): void {
    this.add({ kind: "notice", text, tone });
  }

  ended(detail: string): void {
    this.state = "ended";
    this.notice(detail, "error");
  }

  permissionAsked(tool: string): void {
    this.state = "waiting";
    this.notice(`Waiting for you: allow ${tool}?`, "warning");
  }

  permissionAnswered(tool: string, answer: "allowed" | "denied" | "dismissed"): void {
    if (this.state === "waiting") this.state = "working";
    const last = this.entries.findLast((entry) => entry.kind === "notice" && entry.text === `Waiting for you: allow ${tool}?`);
    const label = { allowed: "Allowed", denied: "Denied", dismissed: "Dismissed" }[answer];
    if (last?.kind === "notice") this.touch(Object.assign(last, { text: `${label} ${tool}`, tone: answer === "allowed" ? "info" : "warning" }));
  }

  replay(messages: StreamMessage[]): void {
    for (const message of messages) {
      for (const block of blocks(message)) {
        if (message.type === "assistant") this.applyAssistantBlock(block);
        else if (block.type === "tool_result") this.applyUserBlock(block);
        else if (block.type === "text" && block.text) this.add({ kind: "user", text: block.text });
      }
    }
    for (const entry of this.entries) if (entry.kind === "tool" && entry.status === "running") entry.status = "error";
    if (this.entries.length > 0) this.notice("Resumed · earlier messages above");
  }

  apply(message: StreamMessage): void {
    if (message.parent_tool_use_id) return;
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.sessionId = message.session_id;
          this.model = message.model;
        }
        return;
      case "stream_event":
        return this.applyEvent(message.event);
      case "assistant":
        this.working();
        for (const block of blocks(message)) this.applyAssistantBlock(block);
        return;
      case "user":
        if (message.isReplay) {
          if (message.uuid) this.pending.delete(message.uuid);
          return;
        }
        if (message.isSynthetic) return;
        for (const block of blocks(message)) this.applyUserBlock(block);
        return;
      case "result":
        this.finishStreaming();
        if (this.interrupting) this.pending.clear();
        this.state = this.pending.size > 0 ? "working" : "idle";
        if (typeof message.total_cost_usd === "number") this.cost = message.total_cost_usd;
        if (message.is_error && !this.interrupting) this.notice(message.result || `Claude stopped: ${message.subtype}`, "error");
        this.interrupting = false;
        return;
    }
  }

  private working(): void {
    if (this.state === "idle") this.state = "working";
  }

  private applyEvent(event: StreamMessage["event"]): void {
    if (!event) return;
    this.working();
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      this.streaming = { kind: "text", text: event.content_block.text ?? "", streaming: true };
      this.add(this.streaming);
    } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && this.streaming) {
      this.streaming.text += event.delta.text ?? "";
      this.touch(this.streaming);
    }
  }

  private applyAssistantBlock(block: Block): void {
    if (block.type === "text") {
      if (this.streaming) {
        this.streaming.text = block.text ?? this.streaming.text;
        this.finishStreaming();
      } else if (block.text) {
        this.add({ kind: "text", text: block.text, streaming: false });
      }
    } else if (block.type === "tool_use" && block.id && !this.entries.some((entry) => entry.kind === "tool" && entry.id === block.id)) {
      this.add({ kind: "tool", id: block.id, name: block.name ?? "tool", summary: oneLine(summarizeToolInput(block.input ?? {})), status: "running" });
    }
  }

  private applyUserBlock(block: Block): void {
    if (block.type === "tool_result") {
      const tool = this.entries.find((entry) => entry.kind === "tool" && entry.id === block.tool_use_id);
      if (tool?.kind === "tool") this.touch(Object.assign(tool, { status: block.is_error ? "error" : "ok" }));
    } else if (block.type === "text" && block.text) {
      const bracketed = /^\[(.*)\]$/s.exec(block.text.trim());
      if (bracketed) this.notice(bracketed[1]!, "warning");
      else this.notice(oneLine(block.text));
    }
  }

  private finishStreaming(): void {
    if (this.streaming) this.touch(Object.assign(this.streaming, { streaming: false }));
    this.streaming = undefined;
  }

  private add(entry: Entry): void {
    this.entries.push(entry);
    this.touch(entry);
  }

  private touch(entry: Entry): void {
    this.changed.add(entry);
  }
}

function blocks(message: StreamMessage): Block[] {
  const content = message.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content ?? [];
}

function oneLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length < text.length ? `${line} …` : line;
}
