import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { controlSocketPath, serveControl } from "./control.ts";
import type { PaneId } from "./layout.ts";
import { Pane } from "./pane.ts";
import { ReadScheduler } from "./pty.ts";
import { MuxView } from "./view.ts";
import { Workspace, type PaneHost } from "./workspace.ts";

const readBudgetMs = 6;
const readWindowMs = 16;
const titleRefreshMs = 1000;

export async function runMux(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], targetFps: 120, maxFps: 120, useMouse: true });
  const scheduler = new ReadScheduler(readBudgetMs, readWindowMs);
  const panes = new Map<PaneId, Pane>();
  const socketPath = controlSocketPath();
  const paneEnv = { QMUX_SOCKET: socketPath };
  let view: MuxView | undefined;

  const refresh = () => {
    if (workspace.quit) return shutdown();
    view?.render();
  };

  const host: PaneHost = {
    create: (id, cwd) => {
      panes.set(id, new Pane(renderer, id, { cwd, env: paneEnv }, scheduler, {
        onExit: (exited) => {
          panes.get(exited)?.destroy();
          panes.delete(exited);
          workspace.paneExited(exited);
          refresh();
        },
        onClick: (clicked) => {
          workspace.focusPane(clicked);
          refresh();
        },
      }));
    },
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
    const cwd = host.cwd(workspace.tab.focused);
    panes.set(id, new Pane(renderer, id, { cwd, command, env: paneEnv }, scheduler, {
      onExit: (exited) => {
        panes.get(exited)?.destroy();
        panes.delete(exited);
        workspace.popupExited(exited);
        refresh();
      },
      onClick: () => {},
    }));
    workspace.openPopup(id, title);
    refresh();
  };

  const control = serveControl(socketPath, (request) => {
    switch (request.method) {
      case "popup.open":
        openPopup(request.params.title, request.params.command);
        return { ok: true };
    }
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (workspace.handleKey(key)) key.preventDefault();
    refresh();
  });
  const titles = setInterval(refresh, titleRefreshMs);

  function shutdown(): void {
    clearInterval(titles);
    control.stop();
    for (const pane of panes.values()) pane.destroy();
    panes.clear();
    renderer.destroy();
    renderer.closed.then(() => process.exit(0));
  }

  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, shutdown);
}
