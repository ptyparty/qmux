import { BoxRenderable, EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import { Pty, ReadScheduler } from "../src/mux/pty.ts";

export class Pane {
  readonly frame: BoxRenderable;
  readonly view: EmbeddedTerminalRenderable;
  private readonly pty: Pty;

  constructor(renderer: CliRenderer, command: string[], title: string, private readonly scheduler: ReadScheduler) {
    this.view = new EmbeddedTerminalRenderable(renderer, {
      width: "100%",
      height: "100%",
      onData: (data) => this.pty.write(data),
      onTerminalResize: (cols, rows) => this.pty.resize(cols, rows),
    });
    this.frame = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#54546d",
      focusedBorderColor: "#7e9cd8",
      title: ` ${title} `,
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      overflow: "hidden",
    });
    this.frame.add(this.view);
    this.pty = new Pty({
      command,
      cols: 80,
      rows: 24,
      scheduler,
      onData: (data) => this.view.write(data),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
  }

  focus(): void {
    this.view.focus();
    this.scheduler.setPriority(this.pty);
  }

  kill(): void {
    this.pty.kill();
  }
}

export function grid(renderer: CliRenderer, panes: Pane[], columns: number): BoxRenderable {
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
  for (let start = 0; start < panes.length; start += columns) {
    const row = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, flexBasis: 0, minHeight: 0 });
    for (const pane of panes.slice(start, start + columns)) row.add(pane.frame);
    root.add(row);
  }
  return root;
}
