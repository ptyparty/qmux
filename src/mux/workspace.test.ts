import { describe, expect, test } from "bun:test";
import { paneIds } from "./layout.ts";
import { configSchema } from "./config.ts";
import type { Project } from "./projects.ts";
import { Workspace, type InputKey, type PaneHost } from "./workspace.ts";

class FakeHost implements PaneHost {
  created: [number, string | undefined][] = [];
  commands = new Map<number, string[] | undefined>();
  destroyed: number[] = [];
  knownProjects: Project[] = [
    { name: "penguin", dir: "/work/exfresso/penguin" },
    { name: "penguin-auth", dir: "/work/stories/penguin-auth" },
    { name: "merlin", dir: "/work/exfresso/merlin" },
  ];
  create(id: number, cwd: string | undefined, command?: string[]): void {
    this.created.push([id, cwd]);
    this.commands.set(id, command);
  }
  projects(): Project[] {
    return this.knownProjects;
  }
  destroy(id: number): void {
    this.destroyed.push(id);
  }
  held = new Set<number>();
  reruns: number[] = [];
  shells: number[] = [];
  isHeld(id: number): boolean {
    return this.held.has(id);
  }
  rerun(id: number): void {
    this.reruns.push(id);
    this.held.delete(id);
  }
  replaceWithShell(id: number): void {
    this.shells.push(id);
    this.held.delete(id);
  }
  closedPopups: number[] = [];
  closePopup(id: number): void {
    this.closedPopups.push(id);
  }
  cwd(id: number): string | undefined {
    return `/work/${id}`;
  }
  screen(): { cols: number; rows: number } {
    return { cols: 200, rows: 50 };
  }
}

function key(spec: string): InputKey {
  const parts = spec.split("+");
  const name = parts.pop()!;
  const shift = parts.includes("shift");
  const sequence = name.length === 1 ? (shift ? name.toUpperCase() : name) : "";
  return { name, ctrl: parts.includes("ctrl"), meta: parts.includes("alt"), shift, sequence };
}

function press(workspace: Workspace, ...keys: string[]): boolean[] {
  return keys.map((spec) => workspace.handleKey(key(spec)));
}

function type(workspace: Workspace, text: string): void {
  for (const char of text) workspace.handleKey({ name: char, ctrl: false, meta: false, shift: false, sequence: char });
}

describe("Workspace", () => {
  test("starts with one tab holding one pane", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host, "/home");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1"]);
    expect(host.created).toEqual([[1, "/home"]]);
  });

  test("normal mode passes ordinary keys through to the pane", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "a", "ctrl+c", "alt+x")).toEqual([false, false, false]);
  });

  test("pane mode splits, moves focus, and returns to normal", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+p", "r");
    expect(workspace.mode).toBe("normal");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
    expect(workspace.tab.focused).toBe(2);
    expect(host.created.at(-1)).toEqual([2, "/work/1"]);
    press(workspace, "alt+h");
    expect(workspace.tab.focused).toBe(1);
    expect(workspace.message).toBe("Focus moved by Alt+h");
    press(workspace, "alt+s");
    expect(workspace.tab.focused).toBe(2);
    press(workspace, "alt+o");
    expect(workspace.tab.focused).toBe(1);
  });

  test("new pane picks the split direction from the pane's shape", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+p", "n");
    expect(workspace.tab.root).toMatchObject({ kind: "split", axis: "row" });
    press(workspace, "ctrl+p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { kind: "split", axis: "column" }] });
  });

  test("modes swallow unbound keys", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+p", "q")).toEqual([true, true]);
    expect(workspace.mode).toBe("pane");
    press(workspace, "escape");
    expect(workspace.mode).toBe("normal");
  });

  test("closing panes collapses the layout and the last pane closes the tab", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+t", "c", "ctrl+p", "x");
    expect(host.destroyed).toEqual([2]);
    expect(workspace.tabs).toHaveLength(1);
    press(workspace, "ctrl+p", "x");
    expect(workspace.quit).toBe(true);
  });

  test("pane exit removes it from its tab", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+p", "d");
    workspace.paneExited(2);
    expect(paneIds(workspace.tab.root)).toEqual([1]);
    expect(workspace.tab.focused).toBe(1);
  });

  test("tab mode creates, cycles, moves, and jumps between tabs", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "c", "ctrl+t", "c");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "Tab #2", "Tab #3"]);
    expect(workspace.active).toBe(2);
    press(workspace, "ctrl+t", "h");
    expect(workspace.active).toBe(1);
    press(workspace, "s", "s");
    expect(workspace.active).toBe(0);
    press(workspace, "n");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #2", "Tab #1", "Tab #3"]);
    press(workspace, "3");
    expect(workspace.active).toBe(2);
    expect(workspace.mode).toBe("normal");
  });

  test("closing a tab requires typing its name", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+t", "c", "ctrl+t", "x");
    expect(workspace.prompt).toMatchObject({ title: "Close tab", detail: 'Type "Tab #2" to close it' });
    type(workspace, "nope");
    press(workspace, "return");
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.message).toBe("Kept the tab");
    press(workspace, "ctrl+t", "x");
    type(workspace, "Tab #2");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1"]);
    expect(host.destroyed).toEqual([2]);
  });

  test("renaming tabs and panes", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "r");
    for (let i = 0; i < 6; i++) press(workspace, "backspace");
    type(workspace, "api");
    press(workspace, "return");
    expect(workspace.tab.name).toBe("api");
    press(workspace, "ctrl+p", "c");
    type(workspace, "server");
    press(workspace, "return");
    expect(workspace.paneNames.get(1)).toBe("server");
  });

  test("session mode d asks to detach", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+o", "d");
    expect(workspace.detachRequested).toBe(true);
    expect(workspace.mode).toBe("normal");
  });

  test("quitting takes session mode then shift+q", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+q");
    expect(workspace.quit).toBe(false);
    press(workspace, "ctrl+o", "q");
    expect(workspace.quit).toBe(false);
    press(workspace, "shift+q");
    expect(workspace.quit).toBe(true);
  });

  test("locked mode passes everything except ctrl+g", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+g");
    expect(press(workspace, "ctrl+p", "alt+h")).toEqual([false, false]);
    press(workspace, "ctrl+g");
    expect(workspace.mode).toBe("normal");
  });

  test("an open popup receives every key until it closes", () => {
    const workspace = new Workspace(new FakeHost());
    const first = workspace.reservePaneId();
    const second = workspace.reservePaneId();
    workspace.openPopup(first, "Deploy?");
    workspace.openPopup(second, "Second");
    expect(press(workspace, "ctrl+p", "escape", "x")).toEqual([false, false, false]);
    expect(workspace.mode).toBe("normal");
    expect(workspace.mode).toBe("normal");
    workspace.popupExited(first);
    expect(workspace.popup?.title).toBe("Second");
    workspace.popupExited(second);
    expect(press(workspace, "ctrl+p")).toEqual([true]);
    expect(workspace.mode).toBe("pane");
  });

  test("a popup belongs to the asking pane's tab and tab keys still work over it", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "c");
    const popup = workspace.reservePaneId();
    workspace.openPopup(popup, "Question", 1);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.popupsWaiting(workspace.tabs[0]!)).toBe(1);
    expect(press(workspace, "a")).toEqual([false]);
    press(workspace, "ctrl+t", "h", "escape");
    expect(workspace.popup?.title).toBe("Question");
    expect(press(workspace, "a")).toEqual([false]);
    expect(press(workspace, "ctrl+t", "s")).toEqual([true, true]);
    expect(workspace.active).toBe(1);
  });

  test("session mode still works over a popup, so a stuck popup can be closed or detached from", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const id = workspace.reservePaneId();
    workspace.openPopup(id, "Stuck");
    expect(press(workspace, "ctrl+o", "x")).toEqual([true, true]);
    expect(host.closedPopups).toEqual([id]);
    press(workspace, "ctrl+o", "d");
    expect(workspace.detachRequested).toBe(true);
  });

  test("opening a project builds its layout in a new tab named after it", () => {
    const host = new FakeHost();
    const config = configSchema.parse({
      projects: { layout: "ide" },
      layouts: { ide: { row: [{ command: ["dev", "claude"], focus: true }, { column: [{ command: ["remax"] }, {}] }] } },
    });
    const workspace = new Workspace(host, "/home", config);
    press(workspace, "ctrl+t", "o");
    expect(workspace.prompt?.matches?.map((match) => match.name)).toEqual(["penguin", "penguin-auth", "merlin"]);
    type(workspace, "pen");
    press(workspace, "tab");
    expect(workspace.prompt?.text).toBe("penguin");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin"]);
    expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
    expect(workspace.tab.focused).toBe(2);
    expect(host.created.slice(1)).toEqual([
      [2, "/work/exfresso/penguin"],
      [3, "/work/exfresso/penguin"],
      [4, "/work/exfresso/penguin"],
    ]);
    expect([host.commands.get(2), host.commands.get(3), host.commands.get(4)]).toEqual([["dev", "claude"], ["remax"], undefined]);
  });

  test("pane groups: new panes join the group, focus walks members left to right, s groups onto the focused pane", () => {
    const config = configSchema.parse({
      projects: { layout: "ide" },
      layouts: { ide: { row: [{ focus: true }, { tabs: [{ command: ["remax"] }, {}] }] } },
    });
    const workspace = new Workspace(new FakeHost(), "/home", config);
    workspace.openProject("merlin");
    expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { kind: "tabs", panes: [3, 4], selected: 0 }] });
    press(workspace, "alt+s", "alt+s");
    expect(workspace.tab.focused).toBe(4);
    expect(workspace.tab.root).toMatchObject({ children: [{}, { selected: 1 }] });
    press(workspace, "ctrl+p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { panes: [3, 4, 5], selected: 2 }] });
    press(workspace, "alt+h", "alt+h");
    expect(workspace.tab.focused).toBe(3);
    press(workspace, "alt+h", "ctrl+p", "s");
    expect(workspace.tab.root).toMatchObject({ children: [{ kind: "tabs", panes: [2, 6], selected: 1 }, {}] });
  });

  test("the project launcher selects matches with the arrow keys", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "o");
    type(workspace, "pen");
    expect(workspace.prompt?.matches?.map((match) => match.name)).toEqual(["penguin", "penguin-auth"]);
    press(workspace, "down");
    expect(workspace.prompt?.selected).toBe(1);
    press(workspace, "down");
    expect(workspace.prompt?.selected).toBe(0);
    press(workspace, "up", "return");
    expect(workspace.tab.name).toBe("penguin-auth");
  });

  test("opening a project that already has a tab switches to it", () => {
    const workspace = new Workspace(new FakeHost());
    expect(workspace.openProject("merlin")).toBeUndefined();
    press(workspace, "ctrl+t", "h");
    expect(workspace.openProject("merl")).toBeUndefined();
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "merlin"]);
    expect(workspace.active).toBe(1);
    expect(workspace.openProject("nothing-like-it")).toBe('No project matches "nothing-like-it"');
  });

  test("a held pane re-runs on Enter, becomes a shell on Esc, and closes on Ctrl+c", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+p", "r");
    host.held.add(2);
    expect(press(workspace, "x", "return")).toEqual([true, true]);
    expect(host.reruns).toEqual([2]);
    host.held.add(2);
    press(workspace, "escape");
    expect(host.shells).toEqual([2]);
    host.held.add(2);
    press(workspace, "ctrl+p", "escape");
    expect(workspace.mode).toBe("normal");
    press(workspace, "ctrl+c");
    expect(paneIds(workspace.tab.root)).toEqual([1]);
    expect(press(workspace, "x")).toEqual([false]);
  });

  test("held pane keys also work in locked mode, and its hints hide behind a popup", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    host.held.add(1);
    press(workspace, "ctrl+g", "return");
    expect(host.reruns).toEqual([1]);
    host.held.add(1);
    expect(workspace.focusedPaneHeld()).toBe(true);
    workspace.openPopup(workspace.reservePaneId(), "Question");
    expect(workspace.focusedPaneHeld()).toBe(false);
  });

  describe("agent states", () => {
    function twoTabs(): Workspace {
      const workspace = new Workspace(new FakeHost());
      press(workspace, "ctrl+p", "r", "ctrl+t", "c");
      return workspace;
    }

    test("states roll up to the tab and only unseen changes notify", () => {
      const workspace = twoTabs();
      expect(workspace.setAgentState(1, "working")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("working");
      expect(workspace.setAgentState(2, "waiting")).toBe(true);
      expect(workspace.setAgentState(2, "waiting")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
      expect(workspace.setAgentState(3, "done")).toBe(false);
      expect(workspace.agents.has(3)).toBe(false);
      expect(workspace.setAgentState(99, "done")).toBe(false);
    });

    test("Alt+a jumps to waiting agents first, then done ones, and focusing clears done", () => {
      const workspace = twoTabs();
      workspace.setAgentState(1, "done");
      workspace.setAgentState(2, "waiting");
      press(workspace, "alt+a");
      expect([workspace.active, workspace.tab.focused]).toEqual([0, 2]);
      workspace.setAgentState(2, undefined);
      press(workspace, "alt+a");
      expect([workspace.active, workspace.tab.focused]).toEqual([0, 1]);
      expect(workspace.agents.has(1)).toBe(false);
      press(workspace, "alt+a");
      expect(workspace.message).toBe("No agent needs you");
    });

    test("typing into a waiting agent's pane means it is being answered", () => {
      const workspace = twoTabs();
      press(workspace, "ctrl+t", "h", "escape");
      workspace.setAgentState(2, "waiting");
      press(workspace, "y");
      expect(workspace.agents.get(2)).toBe("working");
    });

    test("an exiting pane forgets its state", () => {
      const workspace = twoTabs();
      workspace.setAgentState(2, "waiting");
      workspace.paneExited(2);
      expect(workspace.agents.has(2)).toBe(false);
    });
  });

  test("there is no resize mode", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+n")).toEqual([false]);
    expect(workspace.mode).toBe("normal");
  });
});
