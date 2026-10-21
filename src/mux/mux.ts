import type { CliRenderer, KeyEvent } from "@opentui/core";
import type { Config } from "./config.ts";
import type { ControlRequest, ControlResponse } from "./control.ts";
import { findProjects } from "./projects.ts";
import type { PaneId } from "./layout.ts";
import { Pane } from "./pane.ts";
import { ReadScheduler } from "./pty.ts";
import { MuxView } from "./view.ts";
import { Workspace, type PaneHost } from "./workspace.ts";

const readBudgetMs = 6;
const readWindowMs = 16;
const titleRefreshMs = 1000;

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
  const paneEnv = { QMUX_SOCKET: options.controlSocket, QMUX_SESSION: options.session };
  let view: MuxView | undefined;
  let stopped = false;

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
  };

  const spawnPane = (id: PaneId, cwd: string | undefined, command: string[] | undefined, onExit: (id: PaneId) => void, holdOnExit = false) => {
    panes.set(id, new Pane(renderer, id, { cwd, command, env: paneEnv, holdOnExit }, scheduler, {
      onHeld: () => refresh(),
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
    create: (id, cwd, command) => spawnPane(id, cwd, command, (exited) => workspace.paneExited(exited), true),
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

  const openPopup = (title: string, command: string[]) => {
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(workspace.tab.focused), command, (exited) => workspace.popupExited(exited));
    workspace.openPopup(id, title);
    refresh();
  };

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
    renderer.keyInput.off("keypress", onKey);
    for (const pane of panes.values()) pane.destroy();
    panes.clear();
  }

  return {
    handleControl: (request) => {
      switch (request.method) {
        case "popup.open":
          openPopup(request.params.title, request.params.command);
          return { ok: true };
        case "session.info":
          return { ok: true, result: { session: options.session, tabs: workspace.tabs.length, panes: panes.size } };
        case "project.open": {
          const error = workspace.openProject(request.params.target);
          refresh();
          return error ? { ok: false, error } : { ok: true };
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
