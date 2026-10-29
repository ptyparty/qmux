import { BoxRenderable, EmbeddedTerminalRenderable, type CliRenderer, type MouseEvent } from "@opentui/core";
import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { GraphicsScanner, type GraphicsCommand } from "./graphics.ts";
import type { PaneId } from "./layout.ts";
import { Pty, type ReadScheduler } from "./pty.ts";
import { theme } from "./theme.ts";
import { wordAt } from "./words.ts";

export type CommandEvent = { kind: "started"; program?: string; commandLine?: string } | { kind: "finished"; code: number };

export type PaneEvents = {
  onExit: (id: PaneId) => void;
  onHeld: (id: PaneId) => void;
  onClick: (id: PaneId) => void;
  onCommand?: (id: PaneId, event: CommandEvent) => void;
  onClipboard?: (id: PaneId, text: string) => void;
  onGraphics?: (id: PaneId, command: GraphicsCommand) => void;
  onFinished?: (id: PaneId, code: number | null) => void;
  onOutput?: (id: PaneId, data: Uint8Array) => void;
};

export type PaneOptions = {
  cwd?: string;
  command?: string[];
  env?: Record<string, string>;
  holdOnExit?: boolean;
  holdOnFailure?: boolean;
  frameless?: boolean;
  job?: boolean;
  scrollbackBytes?: number;
};

const resetTerminal = "\x1bc";
const fishIntegration = new URL("../shell/qmux.fish", import.meta.url).pathname;
const commandMark = /\x1b\]133;([CD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
const markTailLength = 1024;
const clipboardWrite = /\x1b\]52;[^;\x07\x1b]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
const clipboardStart = "\x1b]52;";
const clipboardPending = /\x1b\]52;[^;\x07\x1b]*(?:;[A-Za-z0-9+/=]*\x1b?)?$/;
const clipboardTailLength = 1024 * 1024;
const doubleClickMs = 400;

export class Pane {
  readonly frame: BoxRenderable;
  private readonly view: EmbeddedTerminalRenderable;
  private pty: Pty;
  private size = { cols: 80, rows: 24 };
  private exitCode: number | null | undefined;
  private command: string[] | undefined;
  private markTail = "";
  private readonly clipboard = new ClipboardScanner();
  private readonly graphics = new GraphicsScanner();
  private lastClick = { at: 0, x: -1, y: -1 };

  constructor(
    private readonly renderer: CliRenderer,
    readonly id: PaneId,
    private readonly options: PaneOptions,
    private readonly scheduler: ReadScheduler,
    private readonly events: PaneEvents,
  ) {
    this.view = new EmbeddedTerminalRenderable(renderer, {
      width: "100%",
      height: "100%",
      selectable: true,
      maxScrollback: options.scrollbackBytes,
      onMouseDown: (event) => this.clicked(event),
      onData: (data) => this.pty.write(data),
      onTerminalResize: (cols, rows) => {
        this.size = { cols, rows };
        this.syncSize();
      },
    });
    const border = options.frameless ? {} : { border: true, borderStyle: "rounded" as const, borderColor: theme.border, titleColor: theme.muted };
    this.frame = new BoxRenderable(renderer, {
      ...border,
      backgroundColor: theme.background,
      width: "100%",
      height: "100%",
      overflow: "hidden",
      onMouseDown: () => events.onClick(id),
    });
    this.frame.add(this.view);
    this.pty = this.start(options.command);
    this.syncSize();
  }

  owns(renderable: unknown): boolean {
    return renderable === this.view;
  }

  get code(): number | null | undefined {
    return this.exitCode;
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  cwd(): string | undefined {
    try {
      return readlinkSync(`/proc/${this.pty.child.pid}/cwd`);
    } catch {
      return this.options.cwd;
    }
  }

  label(name: string | undefined): string {
    const base = name ?? this.command?.join(" ") ?? this.directoryLabel();
    if (this.exitCode === undefined) return base;
    return `${base} · exited${this.exitCode === null ? "" : ` ${this.exitCode}`}`;
  }

  show(title: string, focused: boolean, focusColor: string = theme.accent): void {
    if (!this.options.frameless) {
      this.frame.title = ` ${title} `;
      this.frame.borderColor = focused ? focusColor : theme.border;
      this.frame.titleColor = this.exited ? theme.warning : focused ? focusColor : theme.muted;
    }
    if (focused) {
      this.view.focus();
      this.scheduler.setPriority(this.pty);
    } else {
      this.view.blur();
    }
  }

  syncSize(): void {
    const { cols, rows } = this.size;
    const resolution = this.renderer.resolution;
    if (!resolution || this.renderer.width === 0 || this.renderer.height === 0) return this.pty.resize(cols, rows);
    const cellWidth = resolution.width / this.renderer.width;
    const cellHeight = resolution.height / this.renderer.height;
    this.pty.resize(cols, rows, Math.round(cols * cellWidth), Math.round(rows * cellHeight));
  }

  rerun(): void {
    this.restartWith(this.options.command);
  }

  replaceWithShell(): void {
    this.restartWith(undefined);
  }

  settle(): void {
    this.options.job = false;
  }

  type(data: string): void {
    this.pty.write(data);
  }

  kill(): void {
    this.pty.child.kill();
  }

  destroy(): void {
    this.pty.kill();
    this.frame.destroyRecursively();
  }

  private restartWith(command: string[] | undefined): void {
    this.exitCode = undefined;
    this.view.write(resetTerminal);
    this.pty = this.start(command);
    this.syncSize();
  }

  private start(command: string[] | undefined): Pty {
    this.command = command;
    const pty: Pty = new Pty({
      command: command ?? shellCommand(),
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: this.options.cwd ?? process.cwd(),
      scheduler: this.scheduler,
      onData: (data) => {
        this.view.write(data);
        this.events.onOutput?.(this.id, data);
        if (this.events.onCommand) this.scanCommandMarks(data);
        for (const text of this.clipboard.scan(data)) this.events.onClipboard?.(this.id, text);
        if (this.events.onGraphics) for (const command of this.graphics.scan(data)) this.events.onGraphics(this.id, command);
      },
      onExit: () => this.childExited(pty, command !== undefined),
      env: { ...paneEnvironment(this.id), ...this.options.env },
    });
    return pty;
  }

  private childExited(pty: Pty, ranCommand: boolean): void {
    if (pty !== this.pty) return;
    if (this.options.holdOnFailure) return this.holdIfFailed(pty);
    if (!ranCommand || !this.options.holdOnExit) return this.events.onExit(this.id);
    this.exitCode = null;
    this.events.onHeld(this.id);
    pty.child.exited.then((code) => {
      if (pty !== this.pty) return;
      this.exitCode = code;
      const status = code === null ? "Exited" : `Exited with code ${code}`;
      const keys = this.options.job ? "Enter re-run · p pane · x close · Esc hide" : "Enter re-run · Esc shell · Ctrl+c close";
      this.view.write(`\r\n\x1b[0m\x1b[2m[${status} · ${keys}]\x1b[0m`);
      this.events.onFinished?.(this.id, code);
      this.events.onHeld(this.id);
    });
  }

  private holdIfFailed(pty: Pty): void {
    pty.child.exited.then((code) => {
      if (pty !== this.pty) return;
      if (code === 0) return this.events.onExit(this.id);
      this.exitCode = code;
      const status = code === null ? "Exited" : `Exited with code ${code}`;
      this.view.write(`\r\n\x1b[0m\x1b[2m[${status} · press any key to close]\x1b[0m`);
      this.events.onHeld(this.id);
    });
  }

  private clicked(event: MouseEvent): void {
    if (event.button !== 0) return;
    const now = performance.now();
    const double = now - this.lastClick.at < doubleClickMs && event.x === this.lastClick.x && event.y === this.lastClick.y;
    this.lastClick = double ? { at: 0, x: -1, y: -1 } : { at: now, x: event.x, y: event.y };
    if (!double || !this.view.shouldStartSelection(event.x, event.y)) return;
    const bounds = wordAt(this.view.screen().lines[event.y - this.view.screenY] ?? "", event.x - this.view.screenX);
    if (!bounds) return;
    this.renderer.startSelection(this.view, this.view.screenX + bounds.start, event.y);
    this.renderer.updateSelection(this.view, this.view.screenX + bounds.end, event.y);
  }

  private scanCommandMarks(data: Uint8Array): void {
    const text = this.markTail + Buffer.from(data).toString("latin1");
    for (const match of text.matchAll(commandMark)) {
      if (match.index! + match[0].length <= this.markTail.length) continue;
      this.events.onCommand?.(this.id, match[1] === "C" ? { kind: "started", program: programOf(match[2]), commandLine: commandLineOf(match[2]) } : { kind: "finished", code: Number(match[2] ?? 0) });
    }
    this.markTail = text.slice(-markTailLength);
  }

  private directoryLabel(): string {
    const cwd = this.cwd();
    if (!cwd) return `Pane #${this.id}`;
    return cwd === homedir() ? "~" : basename(cwd);
  }
}

export class ClipboardScanner {
  private tail = "";

  scan(data: Uint8Array): string[] {
    const text = this.tail + Buffer.from(data).toString("latin1");
    const writes: string[] = [];
    let scanned = 0;
    for (const match of text.matchAll(clipboardWrite)) {
      scanned = match.index! + match[0].length;
      const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
      if (decoded !== "") writes.push(decoded);
    }
    const pending = text.lastIndexOf(clipboardStart);
    const unfinished = pending >= scanned && text.length - pending <= clipboardTailLength && clipboardPending.test(text.slice(pending));
    this.tail = unfinished ? text.slice(pending) : text.slice(Math.max(scanned, text.length - clipboardStart.length + 1));
    return writes;
  }
}

export function programOf(params: string | undefined): string | undefined {
  const commandLine = commandLineOf(params);
  if (commandLine === undefined) return undefined;
  const word = commandLine.trim().split(/\s+/).find((token) => !/^\w+=/.test(token));
  return word ? basename(word) : undefined;
}

export function commandLineOf(params: string | undefined): string | undefined {
  const encoded = params?.match(/(?:^|;)cmdline_url=([^;]*)/)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded).trim();
  } catch {
    return undefined;
  }
}

function shellCommand(): string[] {
  const shell = process.env.SHELL ?? "/bin/sh";
  return basename(shell) === "fish" ? [shell, "-C", `source ${fishIntegration}`] : [shell];
}

function paneEnvironment(id: PaneId): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", QMUX: "1", QMUX_PANE_ID: String(id) };
  for (const key of Object.keys(env)) if (key.startsWith("ZELLIJ") || key === "TMUX" || key === "TMUX_PANE") delete env[key];
  return env;
}
