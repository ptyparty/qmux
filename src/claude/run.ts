import { BoxRenderable, TextareaRenderable, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlError, sendControl } from "../mux/control.ts";
import { theme } from "../mux/theme.ts";
import { decidePermission } from "./permissions.ts";
import { pickSession } from "./picker.ts";
import { pastSessions, pickerItems, projectDir, runningSessions, sessionIds, type Choice, type LiveSession } from "./sessions.ts";
import { ClaudeSession } from "./session.ts";
import { ClaudeView, composeKeyBindings } from "./view.ts";

export async function runClaude(args: string[], options: { pick: boolean }): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  let choice: Choice | undefined = { kind: "new" };
  try {
    if (options.pick) choice = await chooseSession(renderer);
    if (choice?.kind === "focus" && !(await focusPane(choice.paneId))) choice = { kind: "resume", sessionId: choice.sessionId };
  } catch (error) {
    renderer.destroy();
    throw error;
  }
  if (choice?.kind !== "new" && choice?.kind !== "resume") {
    renderer.destroy();
    await renderer.closed;
    return;
  }
  if (choice.kind === "resume") args = ["--resume", choice.sessionId, ...args];
  let view: ClaudeView | undefined;
  let session: ClaudeSession | undefined;
  let inbox: { stop: () => Promise<void> } | undefined;
  let failure: string | undefined;
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
    const code = await Promise.race([quitting.then(() => 0), session.exited]);
    const last = session.transcript.entries.at(-1);
    if (code !== 0 && last?.kind === "notice") failure = last.text;
  } finally {
    for (const signal of signals) process.off(signal, quit);
    view?.destroy();
    view = undefined;
    await inbox?.stop();
    session?.stop();
    renderer.destroy();
    await renderer.closed;
  }
  if (failure) console.error(failure);
  const id = session?.transcript.sessionId;
  if (id) console.log(`Continue this conversation with: claude --resume ${id}`);
}

async function chooseSession(renderer: CliRenderer): Promise<Choice | undefined> {
  const cwd = process.cwd();
  const dir = projectDir(cwd);
  const known = sessionIds(dir);
  if (known.length === 0) return { kind: "new" };
  const [past, running, live] = await Promise.all([pastSessions(dir, 8), runningSessions(cwd), liveSessions()]);
  const items = pickerItems({ live, running, past, known, now: Date.now() });
  if (items.length === 1) return items[0]!.choice;
  return pickSession(renderer, cwd, items);
}

async function liveSessions(): Promise<LiveSession[]> {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane } = process.env;
  if (!control) return [];
  try {
    const response = await sendControl(control, { method: "claude.sessions" }, 1000);
    return response.ok ? (response.result as LiveSession[]).filter((session) => String(session.paneId) !== pane) : [];
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return [];
  }
}

async function focusPane(paneId: number): Promise<boolean> {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane } = process.env;
  if (!control) return false;
  const own = Number(pane);
  const closing = Number.isInteger(own) && !startedFromShell() ? own : undefined;
  try {
    return (await sendControl(control, { method: "pane.focus", params: { paneId, closing } }, 1000)).ok;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return false;
  }
}

const shells = new Set(["bash", "fish", "zsh", "sh", "dash", "nu", "ksh", "tcsh"]);

function startedFromShell(): boolean {
  try {
    return shells.has(readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim());
  } catch {
    return false;
  }
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
