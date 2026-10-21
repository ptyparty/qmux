import type { CliRenderer, KeyEvent } from "@opentui/core";
import type { ControlRequest, ControlResponse } from "./control.ts";
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
  onDetach: () => void;
  onQuit: () => void;
};

export type Mux = {
  handleControl: (request: ControlRequest) => ControlResponse;
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

  const spawnPane = (id: PaneId, cwd: string | undefined, command: string[] | undefined, onExit: (id: PaneId) => void) => {
    panes.set(id, new Pane(renderer, id, { cwd, command, env: paneEnv }, scheduler, {
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
    create: (id, cwd) => spawnPane(id, cwd, undefined, (exited) => workspace.paneExited(exited)),
    destroy: (id) => {
      panes.get(id)?.destroy();
      panes.delete(id);
    },
    cwd: (id) => panes.get(id)?.cwd(),
    screen: () => ({ cols: renderer.width, rows: renderer.height }),
  };

  const workspace = new Workspace(host, process.cwd());
  view = new MuxView(renderer, workspace, panes);
  view.render();

  const openPopup = (title: string, command: string[]) => {
    const id = workspace.reservePaneId();
    spawnPane(id, host.cwd(workspace.tab.focused), command, (exited) => workspace.popupExited(exited));
    workspace.openPopup(id, title);
    refresh();
  };

  const onKey = (key: KeyEvent) => {
    if (workspace.handleKey(key)) key.preventDefault();
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
        case "session.quit":
          workspace.quit = true;
          refresh();
          return { ok: true };
      }
    },
    shutdown,
  };
}
