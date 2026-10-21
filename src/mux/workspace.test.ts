import { describe, expect, test } from "bun:test";
import { paneIds } from "./layout.ts";
import { Workspace, type InputKey, type PaneHost } from "./workspace.ts";

class FakeHost implements PaneHost {
  created: [number, string | undefined][] = [];
  destroyed: number[] = [];
  create(id: number, cwd: string | undefined): void {
    this.created.push([id, cwd]);
  }
  destroy(id: number): void {
    this.destroyed.push(id);
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
    expect(workspace.tab.root).toMatchObject({ children: [{}, { node: { kind: "split", axis: "column" } }] });
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
    expect(workspace.prompt?.label).toBe('Type "Tab #2" to close this tab');
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
    expect(press(workspace, "ctrl+p", "escape", "ctrl+o")).toEqual([false, false, false]);
    expect(workspace.mode).toBe("normal");
    workspace.popupExited(first);
    expect(workspace.popup?.title).toBe("Second");
    workspace.popupExited(second);
    expect(press(workspace, "ctrl+p")).toEqual([true]);
    expect(workspace.mode).toBe("pane");
  });

  test("resize mode grows the focused pane", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+p", "r", "ctrl+n", "h", "h", "shift+h");
    const root = workspace.tab.root as { children: { weight: number }[] };
    expect(root.children[0]!.weight).toBeCloseTo(0.45);
    expect(root.children[1]!.weight).toBeCloseTo(0.55);
  });
});
