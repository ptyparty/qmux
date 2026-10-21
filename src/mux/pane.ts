import { BoxRenderable, EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { PaneId } from "./layout.ts";
import { Pty, type ReadScheduler } from "./pty.ts";
import { theme } from "./theme.ts";

export type PaneEvents = { onExit: (id: PaneId) => void; onClick: (id: PaneId) => void };

export type PaneOptions = { cwd?: string; command?: string[]; env?: Record<string, string> };

export class Pane {
  readonly frame: BoxRenderable;
  private readonly view: EmbeddedTerminalRenderable;
  private readonly pty: Pty;

  constructor(
    renderer: CliRenderer,
    readonly id: PaneId,
    options: PaneOptions,
    private readonly scheduler: ReadScheduler,
    events: PaneEvents,
  ) {
    this.view = new EmbeddedTerminalRenderable(renderer, {
      width: "100%",
      height: "100%",
      onData: (data) => this.pty.write(data),
      onTerminalResize: (cols, rows) => this.pty.resize(cols, rows),
    });
    this.frame = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      titleColor: theme.muted,
      backgroundColor: theme.background,
      width: "100%",
      height: "100%",
      overflow: "hidden",
      onMouseDown: () => events.onClick(id),
    });
    this.frame.add(this.view);
    this.pty = new Pty({
      command: options.command ?? [process.env.SHELL ?? "/bin/sh"],
      cols: 80,
      rows: 24,
      cwd: options.cwd ?? process.cwd(),
      scheduler,
      onData: (data) => this.view.write(data),
      onExit: () => events.onExit(id),
      env: { ...paneEnvironment(id), ...options.env },
    });
  }

  cwd(): string | undefined {
    try {
      return readlinkSync(`/proc/${this.pty.child.pid}/cwd`);
    } catch {
      return undefined;
    }
  }

  label(name: string | undefined): string {
    if (name) return name;
    const cwd = this.cwd();
    if (!cwd) return `Pane #${this.id}`;
    return cwd === homedir() ? "~" : basename(cwd);
  }

  show(title: string, focused: boolean): void {
    this.frame.title = ` ${title} `;
    this.frame.borderColor = focused ? theme.accent : theme.border;
    this.frame.titleColor = focused ? theme.accent : theme.muted;
    if (focused) {
      this.view.focus();
      this.scheduler.setPriority(this.pty);
    } else {
      this.view.blur();
    }
  }

  kill(): void {
    this.pty.child.kill();
  }

  destroy(): void {
    this.pty.kill();
    this.frame.destroyRecursively();
  }
}

function paneEnvironment(id: PaneId): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", QMUX: "1", QMUX_PANE_ID: String(id) };
  for (const key of Object.keys(env)) if (key.startsWith("ZELLIJ") || key === "TMUX" || key === "TMUX_PANE") delete env[key];
  return env;
}
