import { BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable, bold, fg, type CliRenderer, type KeyEvent, type Renderable, type SyntaxStyle } from "@opentui/core";
import { markdownStyle } from "../form/view.ts";
import { theme } from "../mux/theme.ts";
import { styled } from "../ui/styled.ts";
import { isQuit } from "./commands.ts";
import { SlashCompletion } from "./completion.ts";
import type { ClaudeSession } from "./session.ts";
import type { Entry, SessionState } from "./transcript.ts";

type Slot = { root: Renderable; update: (entry: Entry) => void };

const stateLabels: Record<SessionState, [string, string]> = {
  idle: ["ready", theme.modes.normal],
  working: ["working", theme.accent],
  waiting: ["waiting for you", theme.warning],
  ended: ["ended", theme.modes.locked],
};

export const composeKeyBindings = [
  { name: "return", action: "submit" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
];

export class ClaudeView {
  private readonly status: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly completion: SlashCompletion;
  private readonly slots = new Map<Entry, Slot>();
  private shown = 0;
  private readonly style: SyntaxStyle;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly session: ClaudeSession,
    private readonly onQuit: () => void,
  ) {
    this.style = markdownStyle(renderer);
    const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background });
    this.status = new TextRenderable(renderer, { height: 1, flexShrink: 0, bg: theme.surface, wrapMode: "none" });
    this.scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, stickyScroll: true, stickyStart: "bottom", paddingLeft: 1, paddingRight: 1 });
    this.scroll.content.flexDirection = "column";
    const inputBox = new BoxRenderable(renderer, { flexShrink: 0, border: ["top"], borderColor: theme.border, paddingLeft: 1, paddingRight: 1 });
    this.input = new TextareaRenderable(renderer, {
      minHeight: 1,
      maxHeight: 8,
      wrapMode: "word",
      placeholder: "Message Claude · / commands · Enter send · Alt+Enter newline · Esc interrupt · Ctrl+d quit",
      placeholderColor: theme.muted,
      textColor: theme.text,
      focusedTextColor: theme.text,
      keyBindings: composeKeyBindings,
      onSubmit: () => this.submit(),
      onContentChange: () => this.completion.update(),
    });
    inputBox.add(this.input);
    this.completion = new SlashCompletion(renderer, this.input, {
      commands: () => this.session.commands,
      submit: () => this.submit(),
      keepsEscape: () => this.session.transcript.state !== "working" && this.session.transcript.state !== "waiting",
    });
    root.add(this.status);
    root.add(this.scroll);
    root.add(this.completion.list);
    root.add(inputBox);
    renderer.root.add(root);
    this.input.focus();
    renderer.keyInput.on("keypress", this.onKey);
  }

  render(): void {
    const { transcript } = this.session;
    const [label, color] = stateLabels[transcript.state];
    const details = [transcript.model, transcript.cost > 0 ? `$${transcript.cost.toFixed(4)}` : undefined, transcript.sessionId?.slice(0, 8)].filter(Boolean);
    this.status.content = styled([bold(fg(color)(` ● ${label} `)), fg(theme.muted)(details.map((detail) => ` ${detail}`).join("  ·"))]);
    for (const entry of transcript.entries.slice(this.shown)) {
      const slot = this.slot(entry);
      this.slots.set(entry, slot);
      this.scroll.add(slot.root);
    }
    this.shown = transcript.entries.length;
    if (this.input.plainText.startsWith("/")) this.completion.update();
    for (const entry of transcript.takeChanges()) this.slots.get(entry)?.update(entry);
    this.renderer.requestRender();
  }

  destroy(): void {
    this.renderer.keyInput.off("keypress", this.onKey);
  }

  private submit(): void {
    const text = this.input.plainText.trim();
    if (!text) return;
    this.input.clear();
    if (isQuit(text)) return this.onQuit();
    this.session.send(text);
  }

  private readonly onKey = (key: KeyEvent) => {
    if (this.completion.handleKey(key)) {
      key.preventDefault();
      return;
    }
    const state = this.session.transcript.state;
    if (key.name === "escape" && (state === "working" || state === "waiting")) {
      this.session.interrupt();
      key.preventDefault();
    } else if (key.name === "pageup" || key.name === "pagedown") {
      this.scroll.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(this.scroll.height - 2, 1));
      key.preventDefault();
    } else if (key.ctrl && key.name === "d" && this.input.plainText === "") {
      key.preventDefault();
      this.onQuit();
    }
  };

  private slot(entry: Entry): Slot {
    if (entry.kind === "text") {
      const markdown = new MarkdownRenderable(this.renderer, { content: entry.text, syntaxStyle: this.style, streaming: entry.streaming, marginTop: 1, tableOptions: { widthMode: "content", cellPaddingX: 1 } });
      return {
        root: markdown,
        update: (next) => {
          if (next.kind !== "text") return;
          markdown.content = next.text;
          markdown.streaming = next.streaming;
        },
      };
    }
    const text = new TextRenderable(this.renderer, { wrapMode: "word" });
    const box = entry.kind === "user" ? new BoxRenderable(this.renderer, { backgroundColor: theme.surface, marginTop: 1, paddingLeft: 1, paddingRight: 1 }) : undefined;
    box?.add(text);
    return { root: box ?? text, update: (next) => (text.content = entryText(next)) };
  }
}

function entryText(entry: Entry) {
  switch (entry.kind) {
    case "user":
      return styled([bold(fg(theme.accent)("› ")), fg(theme.text)(entry.text)]);
    case "tool": {
      const mark = entry.status === "running" ? fg(theme.muted)(" …") : entry.status === "ok" ? fg(theme.modes.normal)(" ✓") : fg(theme.modes.locked)(" ✗");
      return styled([fg(theme.muted)("▸ "), bold(fg(theme.text)(entry.name)), fg(theme.muted)(`  ${entry.summary}`), mark]);
    }
    case "notice": {
      const color = entry.tone === "error" ? theme.modes.locked : entry.tone === "warning" ? theme.warning : theme.muted;
      return styled([fg(color)(entry.text)]);
    }
    case "text":
      return styled([entry.text]);
  }
}
