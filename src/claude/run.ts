import { BoxRenderable, TextareaRenderable, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlError, sendControl } from "../mux/control.ts";
import { theme } from "../mux/theme.ts";
import { decidePermission } from "./permissions.ts";
import { declineHooks, defaultHookCommand, hooksDeclined, installHooks, missingHooks, readSettings, settingsPaths, writeSettings } from "./hooks-setup.ts";
import { pick } from "./picker.ts";
import { pastSessions, pickerItems, projectDir, readHistory, runningSessions, sessionIds, type Choice, type LiveSession } from "./sessions.ts";
import { ClaudeSession } from "./session.ts";
import type { Entry } from "./transcript.ts";
import { ClaudeView, composeKeyBindings } from "./view.ts";
import { parseCommands, type SlashCommand } from "./commands.ts";
import { SlashCompletion } from "./completion.ts";

export async function runClaude(args: string[], options: { pick: boolean }): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const queued: string[] = [];
  let deliverTo: ((text: string) => void) | undefined;
  let session: ClaudeSession | undefined;
  let inbox: Inbox | undefined;
  let choice: Choice | undefined = { kind: "new" };
  const leave = () => {
    void (inbox?.stop() ?? Promise.resolve()).finally(() => {
      renderer.destroy();
      process.exit(0);
    });
  };
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, leave);
  try {
    if (options.pick && runningAsJob()) {
      inbox = await openInbox((text) => (deliverTo ? deliverTo(text) : queued.push(text)), { dormant: true, commands: () => session?.commands ?? [] });
    }
    if (inbox) choice = await wakeAndChoose(renderer, inbox);
    else {
      if (process.env.QMUX_SOCKET) await offerHooks(renderer);
      if (options.pick) choice = await chooseSession(renderer);
    }
    if (choice?.kind === "focus" && !(await focusPane(choice.paneId))) choice = { kind: "resume", sessionId: choice.sessionId };
  } catch (error) {
    await inbox?.stop().catch(() => {});
    renderer.destroy();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, leave);
  }
  if (choice?.kind !== "new" && choice?.kind !== "resume") {
    await inbox?.stop();
    renderer.destroy();
    await renderer.closed;
    return;
  }
  const history = choice.kind === "resume" ? await readHistory(projectDir(process.cwd()), choice.sessionId) : [];
  if (choice.kind === "resume") args = ["--resume", choice.sessionId, ...args];
  if (inbox) await hideOwnJob();
  let view: ClaudeView | undefined;
  let failure: string | undefined;
  let quit: () => void = () => {};
  const quitting = new Promise<void>((resolve) => (quit = resolve));
  for (const signal of signals) process.on(signal, quit);
  try {
    const report = activityReporter();
    session = new ClaudeSession({
      cwd: process.cwd(),
      args,
      env: process.env,
      decide: decidePermission,
      onChange: () => {
        view?.render();
        if (session) report(session.transcript.entries);
      },
    });
    session.transcript.replay(history);
    view = new ClaudeView(renderer, session, () => quit());
    view.render();
    const target = session;
    deliverTo = (text) => target.send(text);
    for (const text of queued.splice(0)) deliverTo(text);
    if (inbox) {
      await inbox.awaken();
      await requestCompose();
    } else inbox = await openInbox(deliverTo, { commands: () => target.commands });
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

async function offerHooks(renderer: CliRenderer): Promise<void> {
  if (await hooksDeclined()) return;
  const paths = settingsPaths();
  let settings, local;
  try {
    [settings, local] = await Promise.all([readSettings(paths.user), readSettings(paths.local)]);
  } catch {
    return;
  }
  const missing = missingHooks([settings, local]);
  if (missing.length === 0) return;
  await showIfJob();
  const answer = await pick(renderer, "qmux hooks", `${missing.length} missing or out of date in ${paths.user}`, [
    { label: "Install them", detail: missing.map((hook) => hook.label).join(" · "), value: "install" },
    { label: "Not now", detail: "ask again next time", value: "later" },
    { label: "Don't ask again", detail: "`qmux hooks --install` installs them any time", value: "never" },
  ]);
  try {
    if (answer === "install") await writeSettings(paths.user, installHooks(settings, [local], defaultHookCommand()));
    if (answer === "never") await declineHooks();
  } catch {}
}

async function chooseSession(renderer: CliRenderer): Promise<Choice | undefined> {
  const cwd = process.cwd();
  const dir = projectDir(cwd);
  const known = sessionIds(dir);
  if (known.length === 0) return { kind: "new" };
  const [past, running, live] = await Promise.all([pastSessions(dir, 8), runningSessions(cwd), liveSessions()]);
  const items = pickerItems({ live, running, past, known, now: Date.now() });
  if (items.length === 1) return items[0]!.choice;
  await showIfJob();
  return pick(renderer, "Claude", cwd, items.map((item) => ({ label: item.label, detail: item.detail, value: item.choice })));
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

export function latestActivity(entries: readonly Entry[]): string | undefined {
  const last = entries.at(-1);
  if (last?.kind === "tool") return `▸ ${last.name}  ${last.summary}`;
  if (last?.kind === "text") return last.text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  return undefined;
}

function activityReporter(intervalMs = 250): (entries: readonly Entry[]) => void {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane } = process.env;
  const paneId = Number(pane);
  let sent: string | undefined;
  let pending: string | undefined;
  let timer: Timer | undefined;
  const flush = () => {
    timer = undefined;
    if (pending === undefined || pending === sent) return;
    sent = pending;
    void sendControl(control!, { method: "agent.activity", params: { paneId, text: pending } }, 1000).catch(() => undefined);
  };
  return (entries) => {
    if (!control || !Number.isInteger(paneId)) return;
    pending = latestActivity(entries);
    timer ??= setTimeout(flush, intervalMs);
  };
}

function showIfJob(): Promise<void> {
  return ownPaneControl((paneId) => ({ method: "pane.focus", params: { paneId, onlyJob: true } }));
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

type Inbox = { stop: () => Promise<void>; awaken: () => Promise<void>; nextWake: () => Promise<void> };

function runningAsJob(): boolean {
  const { QMUX_JOB: job, QMUX_PANE_ID: pane, QMUX_SOCKET: control } = process.env;
  return Boolean(control) && job !== undefined && job === pane;
}

async function wakeAndChoose(renderer: CliRenderer, inbox: Inbox): Promise<Choice | undefined> {
  let hooksOffered = false;
  for (;;) {
    await dormant(renderer, inbox);
    if (!hooksOffered) {
      await offerHooks(renderer);
      hooksOffered = true;
    }
    const choice = await chooseSession(renderer);
    if (choice) return choice;
    await hideOwnJob();
  }
}

function dormant(renderer: CliRenderer, inbox: Inbox): Promise<void> {
  const box = new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: theme.background, padding: 1 });
  box.add(new TextRenderable(renderer, { content: "Claude isn't running in this tab · Alt c starts it · Enter starts it here", fg: theme.muted }));
  renderer.root.add(box);
  renderer.requestRender();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      renderer.keyInput.off("keypress", onKey);
      renderer.root.remove(box);
      box.destroyRecursively();
      resolve();
    };
    const onKey = (key: KeyEvent) => {
      if (key.name === "return") finish();
    };
    renderer.keyInput.on("keypress", onKey);
    void inbox.nextWake().then(finish);
  });
}

async function ownPaneControl(request: (paneId: number) => Parameters<typeof sendControl>[1]): Promise<void> {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane } = process.env;
  const paneId = Number(pane);
  if (!control || !Number.isInteger(paneId)) return;
  await sendControl(control, request(paneId), 1000).catch(() => undefined);
}

function hideOwnJob(): Promise<void> {
  return ownPaneControl((jobId) => ({ method: "job.hide", params: { jobId } }));
}

function requestCompose(): Promise<void> {
  return ownPaneControl((paneId) => ({ method: "claude.compose", params: { paneId } }));
}

async function openInbox(onText: (text: string) => void, options: { dormant?: boolean; commands?: () => SlashCommand[] } = {}): Promise<Inbox | undefined> {
  const { QMUX_SOCKET: control, QMUX_PANE_ID: pane, QMUX_TAB_DIR: dir } = process.env;
  const paneId = Number(pane);
  if (!control || !dir || !Number.isInteger(paneId)) return undefined;
  const path = join(dir, `claude-${paneId}.sock`);
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  let wake: (() => void) | undefined;
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          try {
            const { text, wake: woken, commands } = JSON.parse(line) as { text?: unknown; wake?: unknown; commands?: unknown };
            if (commands === true) socket.write(`${JSON.stringify({ commands: options.commands?.() ?? [] })}\n`);
            else if (woken === true) wake?.();
            else if (typeof text === "string" && text.trim()) onText(text.trim());
          } catch {}
        }
      },
    },
  });
  const register = async (socket: string | null, dormant = false): Promise<boolean> => {
    try {
      return (await sendControl(control, { method: "claude.register", params: { paneId, socket, dormant } }, 1000)).ok;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      return false;
    }
  };
  const stop = async () => {
    server.stop(true);
    rmSync(path, { force: true });
    await register(null);
  };
  try {
    if (!(await register(path, options.dormant)) && options.dormant) {
      await stop();
      return undefined;
    }
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  const nextWake = () =>
    new Promise<void>((resolve) => {
      wake = () => {
        wake = undefined;
        resolve();
      };
    });
  return { stop, awaken: async () => void (await register(path)), nextWake };
}

export async function runCompose(socket: string, name: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const text = await composeMessage(renderer, name, () => fetchCommands(socket));
  renderer.destroy();
  await renderer.closed;
  if (text) await deliver(socket, text);
}

function composeMessage(renderer: CliRenderer, name: string, load: () => Promise<SlashCommand[]>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let commands: SlashCommand[] = [];
    let loading: Promise<void> | undefined;
    const fetch = () => {
      loading ??= load().then((found) => {
        commands = found;
        if (found.length === 0) loading = undefined;
        completion.update();
      });
    };
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.background, paddingLeft: 1, paddingRight: 1 });
    box.add(new TextRenderable(renderer, { content: `To ${name} · / commands · Enter send · Alt+Enter newline · Esc cancel`, fg: theme.muted, height: 1, flexShrink: 0 }));
    const send = () => resolve(input.plainText.trim() || undefined);
    const input: TextareaRenderable = new TextareaRenderable(renderer, {
      flexGrow: 1,
      wrapMode: "word",
      textColor: theme.text,
      focusedTextColor: theme.text,
      keyBindings: composeKeyBindings,
      onSubmit: send,
      onContentChange: () => {
        if (commands.length === 0 && input.plainText.startsWith("/")) fetch();
        completion.update();
      },
    });
    const completion = new SlashCompletion(renderer, input, { commands: () => commands, submit: send, local: false });
    box.add(completion.list);
    box.add(input);
    renderer.root.add(box);
    input.focus();
    fetch();
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (completion.handleKey(key)) key.preventDefault();
      else if (key.name === "escape") resolve(undefined);
    });
  });
}

function fetchCommands(socket: string, timeoutMs = 1000): Promise<SlashCommand[]> {
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve([]), timeoutMs);
    const done = (commands: SlashCommand[]) => {
      clearTimeout(timer);
      resolve(commands);
    };
    Bun.connect({
      unix: socket,
      socket: {
        open: (connection) => void connection.write(`${JSON.stringify({ commands: true })}\n`),
        data: (connection, data) => {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          connection.end();
          try {
            done(parseCommands((JSON.parse(buffer.slice(0, newline)) as { commands?: unknown }).commands));
          } catch {
            done([]);
          }
        },
        error: () => done([]),
      },
    }).catch(() => done([]));
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
