import { BoxRenderable, TextareaRenderable, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ControlError, sendControl } from "../mux/control.ts";
import { theme } from "../mux/theme.ts";
import { decidePermission } from "./permissions.ts";
import { ClaudeSession } from "./session.ts";
import { ClaudeView, composeKeyBindings } from "./view.ts";

export async function runClaude(args: string[]): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  let view: ClaudeView | undefined;
  let session: ClaudeSession | undefined;
  let inbox: { stop: () => Promise<void> } | undefined;
  let quit: () => void = () => {};
  const quitting = new Promise<void>((resolve) => (quit = resolve));
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, quit);
  try {
    session = new ClaudeSession({ cwd: process.cwd(), args, env: process.env, decide: decidePermission, onChange: () => view?.render() });
    view = new ClaudeView(renderer, session, () => quit());
    view.render();
    const target = session;
    inbox = await openInbox((text) => target.send(text));
    await Promise.race([quitting, session.exited]);
  } finally {
    for (const signal of signals) process.off(signal, quit);
    view?.destroy();
    view = undefined;
    await inbox?.stop();
    session?.stop();
    renderer.destroy();
    await renderer.closed;
  }
  const id = session?.transcript.sessionId;
  if (id) console.log(`Continue this conversation with: claude --resume ${id}`);
}

async function openInbox(onText: (text: string) => void): Promise<{ stop: () => Promise<void> } | undefined> {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane, QMUX_TAB_DIR: dir } = process.env;
  const paneId = Number(pane);
  if (!control || !dir || !Number.isInteger(paneId)) return undefined;
  const path = join(dir, `claude-${paneId}.sock`);
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          try {
            const { text } = JSON.parse(line) as { text?: unknown };
            if (typeof text === "string" && text.trim()) onText(text.trim());
          } catch {}
        }
      },
    },
  });
  const register = async (socket: string | null) => {
    try {
      await sendControl(control, { method: "claude.register", params: { paneId, socket } }, 1000);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
    }
  };
  const stop = async () => {
    server.stop(true);
    rmSync(path, { force: true });
    await register(null);
  };
  try {
    await register(path);
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return { stop };
}

export async function runCompose(socket: string, name: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const text = await composeMessage(renderer, name);
  renderer.destroy();
  await renderer.closed;
  if (text) await deliver(socket, text);
}

function composeMessage(renderer: CliRenderer, name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.background, paddingLeft: 1, paddingRight: 1 });
    box.add(new TextRenderable(renderer, { content: `To ${name} · Enter send · Alt+Enter newline · Esc cancel`, fg: theme.muted, height: 1, flexShrink: 0 }));
    const input = new TextareaRenderable(renderer, { flexGrow: 1, wrapMode: "word", textColor: theme.text, focusedTextColor: theme.text, keyBindings: composeKeyBindings, onSubmit: () => resolve(input.plainText.trim() || undefined) });
    box.add(input);
    renderer.root.add(box);
    input.focus();
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "escape") resolve(undefined);
    });
  });
}

function deliver(socket: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      unix: socket,
      socket: {
        open(connection) {
          connection.end(`${JSON.stringify({ text })}\n`);
          resolve();
        },
        data() {},
        error(_connection, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}
