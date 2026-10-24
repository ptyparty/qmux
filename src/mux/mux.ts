import type { CliRenderer, KeyEvent } from "@opentui/core";
import { join } from "node:path";
import { runtimeDir } from "../private-dir.ts";
import type { Config } from "./config.ts";
import type { ControlRequest, ControlResponse } from "./control.ts";
import { findProjects } from "./projects.ts";
import { paneIds, type PaneId } from "./layout.ts";
import { Pane, type CommandEvent } from "./pane.ts";
import { ReadScheduler } from "./pty.ts";
import { TabServices } from "./services.ts";
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
  const paneEnv = { ...options.config.env, QMUX_SOCKET: options.controlSocket, QMUX_SESSION: options.session };
  const services = new TabServices(join(runtimeDir(), "sessions", options.session, "tabs"), () => ({ ...process.env, ...paneEnv }), (tabId, service, detail) => {
    workspace.serviceFailed(tabId, service, detail);
    refresh();
  });
  let view: MuxView | undefined;
  let stopped = false;

  let popupTimer: Timer | undefined;
  const runningCommands = new Map<PaneId, { started: number; timer: Timer }>();

  const copyToClipboard = (text: string) => {
    workspace.message = renderer.copyToClipboardOSC52(text) ? `Copied ${text.length} characters` : "This terminal does not support copying (OSC 52)";
    refresh();
  };

  const commandEvent = (id: PaneId, event: CommandEvent) => {
    const running = runningCommands.get(id);
    if (running) clearTimeout(running.timer);
    runningCommands.delete(id);
    if (event.kind === "started") {
      if (event.program && options.config.untrackedCommands.includes(event.program)) return;
      const timer = setTimeout(() => {
        workspace.setCommandState(id, "running");
        refresh();
      }, longCommandMs);
      runningCommands.set(id, { started: Date.now(), timer });
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
    const wait = workspace.popupWaitMs();
    clearTimeout(popupTimer);
    if (wait !== undefined) popupTimer = setTimeout(refresh, wait + 20);
  };

  type SpawnOptions = { holdOnExit?: boolean; holdOnFailure?: boolean; frameless?: boolean; tabId?: number };
  const spawnPane = (id: PaneId, cwd: string | undefined, command: string[] | undefined, onExit: (id: PaneId) => void, options: SpawnOptions = {}) => {
    const { holdOnExit, holdOnFailure, frameless, tabId } = options;
    const env = tabId === undefined ? paneEnv : { ...paneEnv, QMUX_TAB_DIR: services.tabDir(tabId) };
    panes.set(id, new Pane(renderer, id, { cwd, command, env, holdOnExit, holdOnFailure, frameless }, scheduler, {
      onHeld: () => refresh(),
      onCommand: frameless || holdOnFailure ? undefined : commandEvent,
      onClipboard: (_, text) => copyToClipboard(text),
      onExit: (exited) => {
        panes.get(exited)?.destroy();
        panes.delete(exited);
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
    startServices: (tabId, specs, cwd) => services.start(tabId, specs, cwd),
    stopServices: (tabId) => void services.stop(tabId),
    isHeld: (id) => panes.get(id)?.exited ?? false,
    rerun: (id) => panes.get(id)?.rerun(),
    replaceWithShell: (id) => panes.get(id)?.replaceWithShell(),
    projects: () => findProjects(options.config.projects.roots),
    destroy: (id) => {
      panes.get(id)?.destroy();
      panes.delete(id);
    },
    closePopup: (id) => panes.get(id)?.kill(),
    cwd: (id) => panes.get(id)?.cwd(),
    screen: () => ({ cols: renderer.width, rows: renderer.height }),
  };

  const workspace = new Workspace(host, process.cwd(), options.config);
  workspace.message = options.configError;
  view = new MuxView(renderer, workspace, panes, (id) => {
    workspace.focusPane(id);
    refresh();
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
    clearTimeout(popupTimer);
    for (const running of runningCommands.values()) clearTimeout(running.timer);
    renderer.keyInput.off("keypress", onKey);
    for (const pane of panes.values()) pane.destroy();
    panes.clear();
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
