import type { CliRenderer, KeyEvent } from "@opentui/core";
import { randomBytes } from "node:crypto";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, runtimeDir } from "../private-dir.ts";
import type { Config } from "./config.ts";
import type { ControlRequest, ControlResponse } from "./control.ts";
import type { GraphicsRelay } from "./graphics.ts";
import { findProjects } from "./projects.ts";
import { paneIds, type PaneId } from "./layout.ts";
import { selfCommand } from "../ask/hosts.ts";
import { Pane, type CommandEvent } from "./pane.ts";
import { ReadScheduler } from "./pty.ts";
import { TabDirs } from "./tab-dirs.ts";
import { LineTail } from "./tail.ts";
import { refuseAgentCommand } from "./agent-jobs.ts";
import { deliver } from "../claude/inbox.ts";
import { bracketedPaste, peekSpec, promptRoute } from "./peek.ts";
import { Tray, trayWidgets } from "./tray.ts";
import { MuxView } from "./view.ts";
import { Workspace, type PaneHost, type PopupSize } from "./workspace.ts";

const readBudgetMs = 6;
const readWindowMs = 16;
const titleRefreshMs = 1000;
const longCommandMs = 1_000;

export type MuxOptions = {
  session: string;
  controlSocket: string;
  config: Config;
  configError?: string;
  graphics: GraphicsRelay;
  onDetach: () => void;
  onQuit: () => void;
};

export type Mux = {
  handleControl: (request: ControlRequest) => ControlResponse;
  counts: () => { tabs: number; panes: number };
  setClients: (count: number) => void;
  shutdown: () => void;
};

export function createMux(renderer: CliRenderer, options: MuxOptions): Mux {
  const scheduler = new ReadScheduler(readBudgetMs, readWindowMs);
  const panes = new Map<PaneId, Pane>();
  const graphics = options.graphics;
  const paneEnv = { ...options.config.env, QMUX_SOCKET: options.controlSocket, QMUX_SESSION: options.session, QMUX_SERVER_ID: randomBytes(8).toString("hex") };
  const tabDirs = new TabDirs(join(runtimeDir(), "sessions", options.session, "tabs"));
  let view: MuxView | undefined;
  let stopped = false;
  let pixelSize = "";

  let popupTimer: Timer | undefined;
  let toastTimer: Timer | undefined;
  const runningCommands = new Map<PaneId, { started: number; timer: Timer; commandLine: string }>();
  const jobLogs = new Map<PaneId, { fd: number; path: string }>();
  const nativeClaudes = new Map<PaneId, string>();
  const paneSessions = new Map<PaneId, string>();

  const copyToClipboard = (text: string) => {
    workspace.message = renderer.copyToClipboardOSC52(text) ? `Copied ${text.length} characters` : "This terminal does not support copying (OSC 52)";
    refresh();
  };

  const commandEvent = (id: PaneId, event: CommandEvent) => {
    const running = runningCommands.get(id);
    if (running) clearTimeout(running.timer);
    runningCommands.delete(id);
    const job = workspace.jobStatus(id);
    if (job) {
      if (!job.command && event.kind === "finished") {
        workspace.jobFinished(id, event.code);
        refresh();
      }
      return;
    }
    if (event.kind === "started") {
      if (event.program && options.config.untrackedCommands.includes(event.program)) return;
      const timer = setTimeout(() => {
        workspace.setCommandState(id, "running");
        refresh();
      }, longCommandMs);
      runningCommands.set(id, { started: Date.now(), timer, commandLine: event.commandLine || event.program || "command" });
      return;
    }
    if (!running || Date.now() - running.started < longCommandMs) return;
    const succeeded = event.code === 0;
    if (workspace.setCommandState(id, succeeded ? "succeeded" : "failed")) {
      const where = workspace.tabOf(id)?.name ?? "qmux";
      renderer.triggerNotification(succeeded ? "A command finished" : `A command failed (exit ${event.code})`, where);
    }
    refresh();
  };
  const refresh = () => {
    if (stopped) return;
    if (workspace.quit) {
      shutdown();
      return options.onQuit();
    }
    if (workspace.detachRequested) {
      workspace.detachRequested = false;
      options.onDetach();
    }
    view?.render();
    syncPixelSize();
    const wait = workspace.popupWaitMs();
    clearTimeout(popupTimer);
    if (wait !== undefined) popupTimer = setTimeout(refresh, wait + 20);
    const expiry = workspace.nextToastExpiry();
    clearTimeout(toastTimer);
    if (expiry !== undefined) toastTimer = setTimeout(refresh, expiry + 20);
  };

  const jobTails = new Map<PaneId, LineTail>();
  let dockTimer: Timer | undefined;

  const openJobLog = (id: PaneId, tabId: number) => {
    const path = join(ensurePrivateDir(join(tabDirs.tabDir(tabId), "jobs")), `${id}.log`);
    jobLogs.set(id, { fd: openSync(path, "a", 0o600), path });
    jobTails.set(id, new LineTail());
  };

  const closeJobLog = (id: PaneId) => {
    const log = jobLogs.get(id);
    if (log) closeSync(log.fd);
    jobLogs.delete(id);
    jobTails.delete(id);
  };

  const refreshDock = () => {
    dockTimer ??= setTimeout(() => {
      dockTimer = undefined;
      refresh();
    }, 200);
  };

  const syncPixelSize = () => {
    const size = JSON.stringify([renderer.resolution, renderer.width, renderer.height]);
    if (size === pixelSize) return;
    pixelSize = size;
    for (const pane of panes.values()) pane.syncSize();
  };

  const trackSession = (id: PaneId, sessionId: string, ended: boolean) => {
    if (ended) {
      if (paneSessions.get(id) === sessionId) paneSessions.delete(id);
    } else if (panes.has(id)) paneSessions.set(id, sessionId);
  };

  const wakeClaude = (socket: string) => {
    void Bun.connect({
      unix: socket,
      socket: {
        open: (connection) => void connection.end(`${JSON.stringify({ wake: true })}\n`),
        data: () => {},
      },
    }).catch(() => undefined);
  };

  const destroyPane = (id: PaneId) => {
    panes.get(id)?.destroy();
    panes.delete(id);
    closeJobLog(id);
    nativeClaudes.delete(id);
    workspace.dormant.delete(id);
    paneSessions.delete(id);
    workspace.activities.delete(id);
    graphics.forgetPane(id);
  };

  const scrollbackBytes = options.config.scrollback * 1_000_000;
  type SpawnOptions = { holdOnExit?: boolean; holdOnFailure?: boolean; frameless?: boolean; job?: boolean; tabId?: number; callerEnv?: Record<string, string> };
  const spawnPane = (id: PaneId, cwd: string | undefined, command: string[] | undefined, onExit: (id: PaneId) => void, options: SpawnOptions = {}) => {
    const { holdOnExit, holdOnFailure, frameless, job, tabId, callerEnv } = options;
    const { QMUX_PANE_ID: _pane, TERM: _term, COLORTERM: _colors, ...inherited } = callerEnv ?? {};
    const env: Record<string, string> = { ...inherited, ...paneEnv };
    if (renderer.capabilities?.kitty_graphics) env.QMUX_KITTY_GRAPHICS = "1";
    if (tabId !== undefined) env.QMUX_TAB_DIR = tabDirs.tabDir(tabId);
    if (job) env.QMUX_JOB = String(id);
    panes.set(id, new Pane(renderer, id, { cwd, command, env, holdOnExit, holdOnFailure, frameless, job, scrollbackBytes }, scheduler, {
      onHeld: () => refresh(),
      onCommand: frameless || holdOnFailure ? undefined : commandEvent,
      onClipboard: (_, text) => copyToClipboard(text),
      onGraphics: (paneId, command) => graphics.forward(paneId, command),
      onOutput: (paneId, data) => {
        const log = jobLogs.get(paneId);
        if (log) writeSync(log.fd, data);
        const job = jobTails.get(paneId)?.push(data) ? workspace.jobStatus(paneId) : undefined;
        if (job?.dock && job.tabId === workspace.tab.id) refreshDock();
      },
      onFinished: (paneId, code) => workspace.jobFinished(paneId, code),
      onExit: (exited) => {
        destroyPane(exited);
        onExit(exited);
        refresh();
      },
      onClick: (clicked) => {
        workspace.focusPane(clicked);
        refresh();
      },
    }));
  };

  const host: PaneHost = {
    create: (id, cwd, command, tabId) => spawnPane(id, cwd, command, (exited) => workspace.paneExited(exited), { holdOnExit: true, tabId }),
    createJob: (id, cwd, command, tabId, env) => {
      spawnPane(id, cwd, command, (exited) => workspace.paneExited(exited), { holdOnExit: true, job: true, tabId, callerEnv: env });
      openJobLog(id, tabId);
    },
    trackJob: (id, tabId) => openJobLog(id, tabId),
    untrackJob: (id) => {
      closeJobLog(id);
      panes.get(id)?.settle();
    },
    runningCommand: (id) => runningCommands.get(id)?.commandLine,
    shellCommand: (text) => [process.env.SHELL ?? "/bin/sh", "-c", text],
    peekReply: (near, title, text) => {
      const tabId = workspace.tabOf(near)?.id;
      if (tabId === undefined) return;
      const spec = join(tabDirs.tabDir(tabId), `peek-${near}.json`);
      void Bun.write(spec, JSON.stringify(peekSpec(title, text))).then(() => {
        openViewPopup(near, [...selfCommand(), "peek", spec, "--pane", String(near)], title, { width: 80, height: 80 }, true);
        refresh();
      });
    },
    composeClaude: (near, candidates) => {
      const awake = (id: PaneId) => nativeClaudes.has(id) && !workspace.dormant.has(id);
      const target = awake(near) ? near : (candidates.find(awake) ?? (nativeClaudes.has(near) ? near : candidates.find((id) => nativeClaudes.has(id))));
      if (target === undefined) return "No native Claude in this tab";
      if (workspace.dormant.has(target)) {
        wakeClaude(nativeClaudes.get(target)!);
        return undefined;
      }
      const name = workspace.paneNames.get(target) ?? workspace.jobStatus(target)?.name ?? "Claude";
      openViewPopup(near, [...selfCommand(), "claude", "compose", "--socket", nativeClaudes.get(target)!, "--name", name], `Message ${name}`, { width: 70, height: 30 });
      return undefined;
    },
    tabClosed: (tabId) => tabDirs.remove(tabId),
    isHeld: (id) => panes.get(id)?.exited ?? false,
    rerun: (id) => {
      const log = jobLogs.get(id);
      if (log) ftruncateSync(log.fd, 0);
      if (jobTails.has(id)) jobTails.set(id, new LineTail());
      panes.get(id)?.rerun();
    },
    replaceWithShell: (id) => panes.get(id)?.replaceWithShell(),
    projects: () => findProjects(options.config.projects.roots),
    destroy: destroyPane,
    closePopup: (id) => panes.get(id)?.kill(),
    cwd: (id) => panes.get(id)?.cwd(),
    screen: () => ({ cols: renderer.width, rows: renderer.height }),
    widgetCount: () => tray.widgets.length,
    openWidget: (index) => openWidget(index),
  };

  const tray = new Tray(trayWidgets(options.config.tray), () => refresh());

  const workspace = new Workspace(host, process.cwd(), options.config);
  workspace.message = options.configError;
  view = new MuxView(renderer, workspace, panes, tray, {
    onFocusPane: (id) => {
      workspace.focusPane(id);
      refresh();
    },
    onOpenWidget: (index) => {
      openWidget(index);
      refresh();
    },
    onOpenJob: (id) => {
      workspace.openJob(id);
      refresh();
    },
    jobLine: (id) => jobTails.get(id)?.line,
  });
  view.render();

  const openPopup = (title: string, command: string[], askingPane: PaneId | undefined) => {
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(askingPane ?? workspace.tab.focused), command, (exited) => workspace.popupExited(exited), { frameless: true });
    if (workspace.openPopup(id, title, askingPane)) {
      const where = workspace.tabOf(askingPane)?.name ?? "qmux";
      renderer.triggerNotification(title, where);
    }
    refresh();
  };

  const openViewPopup = (near: PaneId, command: string[], title: string, size: PopupSize | undefined, frameless = false): PaneId | undefined => {
    const tabId = workspace.tabOf(near)?.id;
    if (tabId === undefined) return undefined;
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(near), command, (exited) => workspace.popupExited(exited), { holdOnFailure: true, tabId, frameless });
    workspace.openViewPopup(id, title, near, size);
    refresh();
    return id;
  };

  function openWidget(index: number): void {
    const widget = tray.widgets[index];
    if (!widget) return;
    if (!widget.open) {
      workspace.message = `The ${widget.name} widget has nothing to open`;
      return;
    }
    openViewPopup(workspace.tab.focused, widget.open, widget.name, undefined);
  }

  tray.start();

  renderer.on("focused_renderable", (renderable: unknown) => {
    const pane = [...panes.values()].find((candidate) => candidate.owns(renderable));
    if (!pane || pane.id === workspace.tab.focused || workspace.popup || !paneIds(workspace.tab.root).includes(pane.id)) return;
    workspace.focusPane(pane.id);
    workspace.message = "Focus moved by a mouse click";
    refresh();
  });

  renderer.on("selection", (selection: { getSelectedText(): string }) => {
    const text = selection.getSelectedText();
    if (text.trim() === "") return;
    copyToClipboard(text);
  });

  const onKey = (key: KeyEvent) => {
    if (!workspace.handleKey(key)) return;
    key.preventDefault();
    refresh();
  };
  renderer.keyInput.on("keypress", onKey);
  const titles = setInterval(refresh, titleRefreshMs);

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(titles);
    tray.stop();
    clearTimeout(popupTimer);
    clearTimeout(toastTimer);
    clearTimeout(dockTimer);
    for (const running of runningCommands.values()) clearTimeout(running.timer);
    renderer.keyInput.off("keypress", onKey);
    for (const id of [...panes.keys()]) destroyPane(id);
  }

  return {
    handleControl: (request) => {
      switch (request.method) {
        case "popup.open":
          openPopup(request.params.title, request.params.command, request.params.paneId);
          return { ok: true };
        case "session.info":
          return { ok: true, result: { session: options.session, tabs: workspace.tabs.length, panes: panes.size } };
        case "agent.session":
          trackSession(request.params.paneId, request.params.sessionId, false);
          return { ok: true };
        case "agent.command": {
          const { paneId, command, background } = request.params;
          const tab = workspace.tabOf(paneId);
          const running = tab ? workspace.tabJobs(tab).filter((job) => job.state === "running") : [];
          return { ok: true, result: { refusal: refuseAgentCommand(options.config.agentJobs, command, background, running) } };
        }
        case "agent.activity": {
          const { paneId, text } = request.params;
          workspace.activities.set(paneId, text);
          const job = workspace.jobStatus(paneId);
          if (job?.dock && job.tabId === workspace.tab.id) refreshDock();
          return { ok: true };
        }
        case "claude.sessions":
          return {
            ok: true,
            result: [...paneSessions].flatMap(([paneId, sessionId]) => {
              const tab = workspace.tabOf(paneId);
              return tab ? [{ paneId, sessionId, tab: tab.name }] : [];
            }),
          };
        case "pane.focus": {
          const { paneId, closing, onlyJob } = request.params;
          if (!workspace.tabOf(paneId)) return { ok: false, error: `no pane ${paneId}` };
          if (workspace.jobStatus(paneId)) workspace.openJob(paneId);
          else if (!onlyJob) workspace.focusPane(paneId);
          if (closing !== undefined && closing !== paneId)
            setTimeout(() => {
              destroyPane(closing);
              workspace.paneExited(closing);
              refresh();
            }, 0);
          refresh();
          return { ok: true };
        }
        case "agent.state": {
          const { paneId, state, detail, sessionId, reply } = request.params;
          if (sessionId) trackSession(paneId, sessionId, state === "clear");
          const notify = workspace.setAgentState(paneId, state === "clear" ? undefined : state, reply);
          if (notify) {
            const where = workspace.tabOf(paneId)?.name ?? "qmux";
            renderer.triggerNotification(detail ?? (state === "waiting" ? "An agent needs you" : "An agent finished"), where);
          }
          refresh();
          return { ok: true };
        }
        case "project.open": {
          const error = workspace.openProject(request.params.target);
          refresh();
          return error ? { ok: false, error } : { ok: true };
        }
        case "pane.open": {
          const { near, placement, command, name, focus, width, height } = request.params;
          const paneId =
            placement === "popup"
              ? openViewPopup(near, command, name ?? command.join(" "), width === undefined && height === undefined ? undefined : { width: width ?? 80, height: height ?? 80 })
              : workspace.openPaneNear(near, placement, command, { name, focus });
          refresh();
          return paneId === undefined ? { ok: false, error: `no pane ${near}` } : { ok: true, result: { paneId } };
        }
        case "job.run": {
          const { near, command, name, cwd, env } = request.params;
          const jobId = workspace.runJob(near, command, name, { cwd, env });
          refresh();
          if (jobId === undefined) return { ok: false, error: `no pane ${near}` };
          return { ok: true, result: { jobId, log: jobLogs.get(jobId)?.path } };
        }
        case "job.status": {
          const job = workspace.jobStatus(request.params.jobId);
          const promoted = job ? undefined : panes.get(request.params.jobId);
          if (promoted) {
            const code = promoted.code;
            const state = code === undefined || code === null ? "running" : code === 0 ? "succeeded" : "failed";
            return { ok: true, result: { state, code: code ?? null } };
          }
          if (!job) return { ok: false, error: `job ${request.params.jobId} was closed` };
          return { ok: true, result: { state: job.state, code: job.code ?? null } };
        }
        case "job.stop":
          if (!workspace.jobStatus(request.params.jobId)) return { ok: false, error: `job ${request.params.jobId} was closed` };
          workspace.closeJob(request.params.jobId);
          refresh();
          return { ok: true };
        case "claude.register": {
          const { paneId, socket, dormant } = request.params;
          if (!panes.has(paneId)) return { ok: false, error: `no pane ${paneId}` };
          if (socket === null) {
            nativeClaudes.delete(paneId);
            workspace.markAgent(paneId, false);
          } else {
            nativeClaudes.set(paneId, socket);
            workspace.markAgent(paneId);
          }
          if (socket !== null && dormant) workspace.dormant.add(paneId);
          else workspace.dormant.delete(paneId);
          refresh();
          return { ok: true };
        }
        case "claude.compose": {
          const message = host.composeClaude(request.params.paneId, [request.params.paneId]);
          return message ? { ok: false, error: message } : { ok: true };
        }
        case "agent.prompt": {
          const { paneId, text } = request.params;
          const pane = panes.get(paneId);
          if (!pane) return { ok: false, error: `no pane ${paneId}` };
          const socket = nativeClaudes.get(paneId);
          const route = promptRoute(socket !== undefined, workspace.agents.get(paneId));
          if (route === "busy") {
            workspace.message = `${workspace.paneNames.get(paneId) ?? workspace.jobStatus(paneId)?.name ?? "Claude"} is busy · open it to answer`;
            refresh();
            return { ok: false, error: "busy" };
          }
          if (route === "socket") void deliver(socket!, text).catch(() => undefined);
          else {
            pane.type(bracketedPaste(text));
            setTimeout(() => pane.type("\r"), 100);
          }
          return { ok: true };
        }
        case "job.hide":
          workspace.popupExited(request.params.jobId);
          refresh();
          return { ok: true };
        case "session.quit":
          workspace.quit = true;
          refresh();
          return { ok: true };
      }
    },
    counts: () => ({ tabs: workspace.tabs.length, panes: panes.size }),
    setClients: (count) => {
      workspace.clients = count;
      refresh();
    },
    shutdown,
  };
}
