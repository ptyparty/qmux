import { BoxRenderable, EmbeddedTerminalRenderable, type CliRenderer, type MouseEvent } from "@opentui/core";
import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { PaneId } from "./layout.ts";
import { Pty, type ReadScheduler } from "./pty.ts";
import { theme } from "./theme.ts";
import { wordAt } from "./words.ts";

export type CommandEvent = { kind: "started" } | { kind: "finished"; code: number };

export type PaneEvents = {
  onExit: (id: PaneId) => void;
  onHeld: (id: PaneId) => void;
  onClick: (id: PaneId) => void;
  onCommand?: (id: PaneId, event: CommandEvent) => void;
};

export type PaneOptions = {
  cwd?: string;
  command?: string[];
  env?: Record<string, string>;
  holdOnExit?: boolean;
  frameless?: boolean;
};

const resetTerminal = "\x1bc";
const fishIntegration = new URL("../shell/qmux.fish", import.meta.url).pathname;
const commandMark = /\x1b\]133;([CD])(?:;(-?\d+))?(?:\x07|\x1b\\)/g;
const markTailLength = 32;
const doubleClickMs = 400;

export class Pane {
  readonly frame: BoxRenderable;
  private readonly view: EmbeddedTerminalRenderable;
  private pty: Pty;
  private size = { cols: 80, rows: 24 };
  private exitCode: number | null | undefined;
  private command: string[] | undefined;
  private markTail = "";
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
      onMouseDown: (event) => this.clicked(event),
      onData: (data) => this.pty.write(data),
      onTerminalResize: (cols, rows) => {
        this.size = { cols, rows };
        this.pty.resize(cols, rows);
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
  }

  owns(renderable: unknown): boolean {
    return renderable === this.view;
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

  rerun(): void {
    this.restartWith(this.options.command);
  }

  replaceWithShell(): void {
    this.restartWith(undefined);
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
        if (this.events.onCommand) this.scanCommandMarks(data);
      },
      onExit: () => this.childExited(pty, command !== undefined),
      env: { ...paneEnvironment(this.id), ...this.options.env },
    });
    return pty;
  }

  private childExited(pty: Pty, ranCommand: boolean): void {
    if (pty !== this.pty) return;
    if (!ranCommand || !this.options.holdOnExit) return this.events.onExit(this.id);
    this.exitCode = null;
    this.events.onHeld(this.id);
    pty.child.exited.then((code) => {
      if (pty !== this.pty) return;
      this.exitCode = code;
      const status = code === null ? "Exited" : `Exited with code ${code}`;
      this.view.write(`\r\n\x1b[0m\x1b[2m[${status} · Enter re-run · Esc shell · Ctrl+c close]\x1b[0m`);
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
      this.events.onCommand?.(this.id, match[1] === "C" ? { kind: "started" } : { kind: "finished", code: Number(match[2] ?? 0) });
    }
    this.markTail = text.slice(-markTailLength);
  }

  private directoryLabel(): string {
    const cwd = this.cwd();
    if (!cwd) return `Pane #${this.id}`;
    return cwd === homedir() ? "~" : basename(cwd);
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
