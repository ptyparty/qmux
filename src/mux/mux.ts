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
import { Pane, type CommandEvent } from "./pane.ts";
import { ReadScheduler } from "./pty.ts";
import { TabServices } from "./services.ts";
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
  const services = new TabServices(join(runtimeDir(), "sessions", options.session, "tabs"), () => ({ ...process.env, ...paneEnv }), (tabId, service, detail) => {
    workspace.serviceFailed(tabId, service, detail);
    refresh();
  });
  let view: MuxView | undefined;
  let stopped = false;
  let pixelSize = "";

  let popupTimer: Timer | undefined;
  let toastTimer: Timer | undefined;
  const runningCommands = new Map<PaneId, { started: number; timer: Timer; commandLine: string }>();
  const jobLogs = new Map<PaneId, { fd: number; path: string }>();

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
      const where = workspace.tabs.find((tab) => paneIds(tab.root).includes(id))?.name ?? "qmux";
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

  const openJobLog = (id: PaneId, tabId: number) => {
    const path = join(ensurePrivateDir(join(services.tabDir(tabId), "jobs")), `${id}.log`);
    jobLogs.set(id, { fd: openSync(path, "a", 0o600), path });
  };

  const closeJobLog = (id: PaneId) => {
    const log = jobLogs.get(id);
    if (log) closeSync(log.fd);
    jobLogs.delete(id);
  };

  const syncPixelSize = () => {
    const size = JSON.stringify([renderer.resolution, renderer.width, renderer.height]);
    if (size === pixelSize) return;
    pixelSize = size;
    for (const pane of panes.values()) pane.syncSize();
  };

  const destroyPane = (id: PaneId) => {
    panes.get(id)?.destroy();
    panes.delete(id);
    closeJobLog(id);
    graphics.forgetPane(id);
  };

  const scrollbackBytes = options.config.scrollback * 1_000_000;
  type SpawnOptions = { holdOnExit?: boolean; holdOnFailure?: boolean; frameless?: boolean; job?: boolean; tabId?: number };
  const spawnPane = (id: PaneId, cwd: string | undefined, command: string[] | undefined, onExit: (id: PaneId) => void, options: SpawnOptions = {}) => {
    const { holdOnExit, holdOnFailure, frameless, job, tabId } = options;
    const env: Record<string, string> = { ...paneEnv };
    if (renderer.capabilities?.kitty_graphics) env.QMUX_KITTY_GRAPHICS = "1";
    if (tabId !== undefined) env.QMUX_TAB_DIR = services.tabDir(tabId);
    panes.set(id, new Pane(renderer, id, { cwd, command, env, holdOnExit, holdOnFailure, frameless, job, scrollbackBytes }, scheduler, {
      onHeld: () => refresh(),
      onCommand: frameless || holdOnFailure ? undefined : commandEvent,
      onClipboard: (_, text) => copyToClipboard(text),
      onGraphics: (paneId, command) => graphics.forward(paneId, command),
      onOutput: (paneId, data) => {
        const log = jobLogs.get(paneId);
        if (log) writeSync(log.fd, data);
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
    createJob: (id, cwd, command, tabId) => {
      spawnPane(id, cwd, command, (exited) => workspace.paneExited(exited), { holdOnExit: true, job: true, tabId });
      openJobLog(id, tabId);
    },
    trackJob: (id, tabId) => openJobLog(id, tabId),
    untrackJob: (id) => {
      closeJobLog(id);
      panes.get(id)?.settle();
    },
    runningCommand: (id) => runningCommands.get(id)?.commandLine,
    shellCommand: (text) => [process.env.SHELL ?? "/bin/sh", "-c", text],
    startServices: (tabId, specs, cwd) => services.start(tabId, specs, cwd),
    stopServices: (tabId) => void services.stop(tabId),
    isHeld: (id) => panes.get(id)?.exited ?? false,
    rerun: (id) => {
      const log = jobLogs.get(id);
      if (log) ftruncateSync(log.fd, 0);
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
  });
  view.render();

  const openPopup = (title: string, command: string[], askingPane: PaneId | undefined) => {
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(askingPane ?? workspace.tab.focused), command, (exited) => workspace.popupExited(exited), { frameless: true });
    if (workspace.openPopup(id, title, askingPane)) {
      const where = workspace.tabs.find((tab) => askingPane !== undefined && paneIds(tab.root).includes(askingPane))?.name ?? "qmux";
      renderer.triggerNotification(title, where);
    }
    refresh();
  };

  const openViewPopup = (near: PaneId, command: string[], title: string, size: PopupSize | undefined): PaneId | undefined => {
    const tabId = workspace.tabs.find((tab) => paneIds(tab.root).includes(near))?.id;
    if (tabId === undefined) return undefined;
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(near), command, (exited) => workspace.popupExited(exited), { holdOnFailure: true, tabId });
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
    for (const running of runningCommands.values()) clearTimeout(running.timer);
    renderer.keyInput.off("keypress", onKey);
    for (const id of [...panes.keys()]) destroyPane(id);
    void services.stopAll();
  }

  return {
    handleControl: (request) => {
      switch (request.method) {
        case "popup.open":
          openPopup(request.params.title, request.params.command, request.params.paneId);
          return { ok: true };
        case "session.info":
          return { ok: true, result: { session: options.session, tabs: workspace.tabs.length, panes: panes.size } };
        case "agent.state": {
          const { paneId, state, detail } = request.params;
          const notify = workspace.setAgentState(paneId, state === "clear" ? undefined : state);
          if (notify) {
            const where = workspace.tabs.find((tab) => paneIds(tab.root).includes(paneId))?.name ?? "qmux";
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
          const { near, command, name } = request.params;
          const jobId = workspace.runJob(near, command, name);
          refresh();
          if (jobId === undefined) return { ok: false, error: `no pane ${near}` };
          return { ok: true, result: { jobId, log: jobLogs.get(jobId)?.path } };
        }
        case "job.status": {
          const job = workspace.jobStatus(request.params.jobId);
          if (!job) return { ok: false, error: `job ${request.params.jobId} was closed` };
          return { ok: true, result: { state: job.state, code: job.code ?? null } };
        }
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
