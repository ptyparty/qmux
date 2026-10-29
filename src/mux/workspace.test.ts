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
  tabOf = new Map<number, number>();
  create(id: number, cwd: string | undefined, command: string[] | undefined, tabId: number): void {
    this.created.push([id, cwd]);
    this.commands.set(id, command);
    this.tabOf.set(id, tabId);
  }
  jobs: [number, string[], number][] = [];
  jobCwds = new Map<number, string | undefined>();
  createJob(id: number, cwd: string | undefined, command: string[], tabId: number): void {
    this.jobs.push([id, command, tabId]);
    this.jobCwds.set(id, cwd);
    this.tabOf.set(id, tabId);
  }
  tracked: number[] = [];
  trackJob(id: number): void {
    this.tracked.push(id);
  }
  untracked: number[] = [];
  untrackJob(id: number): void {
    this.untracked.push(id);
  }
  running = new Map<number, string>();
  runningCommand(id: number): string | undefined {
    return this.running.get(id);
  }
  shellCommand(text: string): string[] {
    return ["sh", "-c", text];
  }
  claudes = new Set<number>();
  composed: number[] = [];
  peeked: [number, string, string][] = [];
  peekReply(near: number, title: string, text: string): void {
    this.peeked.push([near, title, text]);
  }
  composeClaude(near: number, candidates: number[]): string | undefined {
    const target = this.claudes.has(near) ? near : candidates.find((id) => this.claudes.has(id));
    if (target === undefined) return "No native Claude in this tab";
    this.composed.push(target);
    return undefined;
  }
  closedTabs: number[] = [];
  tabClosed(tabId: number): void {
    this.closedTabs.push(tabId);
  }
  layoutJobs(): [string[], number, string | undefined][] {
    return this.jobs.map(([id, command, tabId]) => [command, tabId, this.jobCwds.get(id)]);
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
  widgets = 2;
  openedWidgets: number[] = [];
  widgetCount(): number {
    return this.widgets;
  }
  openWidget(index: number): void {
    this.openedWidgets.push(index);
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

  test("pane mode moves the focused pane with the focus keys", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+p", "r", "ctrl+p", "alt+h");
    expect(paneIds(workspace.tab.root)).toEqual([2, 1]);
    expect([workspace.tab.focused, workspace.mode]).toEqual([2, "pane"]);
    press(workspace, "alt+right");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
    press(workspace, "alt+s");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
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
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "ctrl+t", "c");
    const popup = workspace.reservePaneId();
    expect(workspace.openPopup(popup, "Question", 1)).toBe(true);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.popupsWaiting(workspace.tabs[0]!)).toBe(1);
    expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
    expect(press(workspace, "a")).toEqual([false]);
    press(workspace, "ctrl+t", "h", "escape");
    clock.now += 2000;
    expect(workspace.popup?.title).toBe("Question");
    expect(press(workspace, "a")).toEqual([false]);
    expect(press(workspace, "ctrl+t", "s")).toEqual([true, true]);
    expect(workspace.active).toBe(1);
  });

  test("the project launcher takes the keys while it is open over a popup", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    const popup = workspace.reservePaneId();
    workspace.openPopup(popup, "Question", 1);
    clock.now += 2000;
    expect(workspace.popup?.title).toBe("Question");
    press(workspace, "ctrl+t", "o");
    expect(press(workspace, "m", "e")).toEqual([true, true]);
    expect(workspace.prompt?.text).toBe("me");
    press(workspace, "escape");
    expect(workspace.prompt).toBeUndefined();
    expect(press(workspace, "a")).toEqual([false]);
    press(workspace, "ctrl+t", "o");
    type(workspace, "merlin");
    press(workspace, "return");
    expect(workspace.tab.name).toBe("merlin");
    expect(workspace.popupsWaiting(workspace.tabs[0]!)).toBe(1);
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

  describe("layout jobs", () => {
    const config = configSchema.parse({
      projects: { layout: "ide", layoutFor: { merlin: "served" } },
      layouts: {
        ide: { row: [{}, {}] },
        served: { jobs: [{ command: ["q-space", "serve"], name: "server", dock: true }, { command: ["make", "watch"] }], row: [{ command: ["q-space", "pane", "stories"] }, {}] },
      },
    });

    test("a project's own layout starts its jobs with the tab, docked as configured", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("penguin");
      expect(host.layoutJobs()).toEqual([]);
      workspace.openProject("merlin");
      const merlin = workspace.tab;
      expect(host.layoutJobs()).toEqual([
        [["q-space", "serve"], merlin.id, "/work/exfresso/merlin"],
        [["make", "watch"], merlin.id, "/work/exfresso/merlin"],
      ]);
      expect(workspace.tabJobs().map((job) => [job.name, job.dock])).toEqual([
        ["server", true],
        ["make watch", false],
      ]);
      expect(paneIds(merlin.root).map((id) => host.tabOf.get(id))).toEqual([merlin.id, merlin.id]);
    });

    test("closing the tab closes its jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("merlin");
      const id = workspace.tab.id;
      const jobs = workspace.tabJobs().map((job) => job.id);
      press(workspace, "ctrl+t", "x");
      type(workspace, "merlin");
      press(workspace, "return");
      expect(host.closedTabs).toEqual([id]);
      expect(host.destroyed).toEqual(expect.arrayContaining(jobs));
      expect(workspace.jobs).toEqual([]);
    });

    test("the last pane exiting closes the tab's jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("merlin");
      const tab = workspace.tab;
      for (const pane of paneIds(tab.root)) workspace.paneExited(pane);
      expect(host.closedTabs).toEqual([tab.id]);
      expect(workspace.tabs).not.toContain(tab);
      expect(workspace.jobs).toEqual([]);
    });

    test("Alt+Enter in the launcher opens a project without its jobs, and Ctrl+s s starts the missing ones", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      press(workspace, "ctrl+t", "o");
      type(workspace, "merlin");
      press(workspace, "alt+return");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.tabJobs()).toEqual([]);
      press(workspace, "ctrl+s", "s");
      expect(workspace.tabJobs().map((job) => [job.name, job.dock, job.layout])).toEqual([
        ["server", true, true],
        ["make watch", false, true],
      ]);
      expect(host.jobCwds.get(workspace.tabJobs()[0]!.id)).toBe("/work/exfresso/merlin");
      press(workspace, "ctrl+s", "s");
      expect(workspace.message).toBe("All of this tab's layout jobs are running");
      const [server, watch] = workspace.tabJobs();
      workspace.closeJob(server!.id);
      workspace.jobFinished(watch!.id, 1);
      press(workspace, "ctrl+s", "s");
      expect(workspace.tabJobs().map((job) => [job.name, job.state])).toEqual([
        ["make watch", "running"],
        ["server", "running"],
      ]);
      expect(host.reruns).toEqual([watch!.id]);
      workspace.openProject("penguin");
      press(workspace, "ctrl+s", "s");
      expect(workspace.message).toBe("This tab's layout has no jobs");
    });

    test("Ctrl+s d docks and undocks the selected job", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      workspace.openProject("merlin");
      press(workspace, "ctrl+s", "down", "d");
      expect(workspace.tabJobs().map((job) => job.dock)).toEqual([true, true]);
      press(workspace, "up", "d");
      expect(workspace.tabJobs().map((job) => job.dock)).toEqual([false, true]);
    });
  });

  describe("named tabs", () => {
    const config = configSchema.parse({
      layouts: {
        "q-space": { jobs: [{ command: ["q-space", "serve"] }], row: [{ command: ["q-space", "pane", "stories"] }, {}] },
        logs: { row: [{}] },
      },
      tabs: { "q-space": { layout: "q-space", cwd: "/home/me/q-space" }, logs: { layout: "logs", cwd: "/var/log" }, penguin: { layout: "logs", cwd: "/elsewhere" } },
      startup: ["logs", "q-space"],
    });

    test("startup tabs replace the plain first tab, in order, with the first focused", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs", "q-space"]);
      expect(workspace.active).toBe(0);
      expect(host.created).toEqual([
        [1, "/var/log"],
        [2, "/home/me/q-space"],
        [3, "/home/me/q-space"],
      ]);
      expect(host.layoutJobs()).toEqual([[["q-space", "serve"], workspace.tabs[1]!.id, "/home/me/q-space"]]);
    });

    test("named tabs lead the launcher and hide a project of the same name", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      press(workspace, "ctrl+t", "o");
      expect(workspace.prompt?.candidates?.map((candidate) => `${candidate.name} ${candidate.dir}`)).toEqual([
        "q-space /home/me/q-space",
        "logs /var/log",
        "penguin /elsewhere",
        "penguin-auth /work/stories/penguin-auth",
        "merlin /work/exfresso/merlin",
      ]);
    });

    test("a closed named tab reopens with its layout and jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.active = 1;
      press(workspace, "ctrl+t", "x");
      type(workspace, "q-space");
      press(workspace, "return");
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs"]);
      expect(workspace.openProject("q-space")).toBeUndefined();
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs", "q-space"]);
      expect(host.layoutJobs().map(([command, , cwd]) => [command, cwd])).toEqual([
        [["q-space", "serve"], "/home/me/q-space"],
        [["q-space", "serve"], "/home/me/q-space"],
      ]);
    });
  });

  test("opening a pane near another places it beside that pane in its tab", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+t", "c");
    expect(workspace.openPaneNear(1, "right", ["q-space", "pane", "comments"], { name: "comments" })).toBe(3);
    expect([workspace.active, workspace.tab.focused]).toEqual([0, 3]);
    expect(workspace.tab.root).toMatchObject({ kind: "split", axis: "row", children: [{ id: 1 }, { id: 3 }] });
    expect(host.tabOf.get(3)).toBe(workspace.tabs[0]!.id);
    expect(host.commands.get(3)).toEqual(["q-space", "pane", "comments"]);
    expect(workspace.paneNames.get(3)).toBe("comments");
    expect(workspace.openPaneNear(3, "tab", ["htop"], { focus: false })).toBe(4);
    expect(workspace.tab.focused).toBe(3);
    expect(workspace.tab.root).toMatchObject({ children: [{ id: 1 }, { kind: "tabs", panes: [3, 4] }] });
    expect(workspace.openPaneNear(1, "below", ["top"])).toBe(5);
    expect(workspace.tab.root).toMatchObject({ children: [{ kind: "split", axis: "column", children: [{ id: 1 }, { id: 5 }] }, {}] });
    expect(workspace.openPaneNear(99, "right", ["top"])).toBeUndefined();
  });

  test("pane groups: focus moves leave a group's shown pane alone, cycling reaches every member, new panes join the group", () => {
    const config = configSchema.parse({
      projects: { layout: "ide" },
      layouts: { ide: { row: [{ focus: true }, { tabs: [{ command: ["remax"] }, {}] }] } },
    });
    const workspace = new Workspace(new FakeHost(), "/home", config);
    workspace.openProject("merlin");
    expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { kind: "tabs", panes: [3, 4], selected: 0 }] });
    press(workspace, "alt+s", "alt+s");
    expect(workspace.tab.focused).toBe(3);
    press(workspace, "alt+e");
    expect(workspace.tab.focused).toBe(4);
    expect(workspace.tab.root).toMatchObject({ children: [{}, { selected: 1 }] });
    press(workspace, "alt+h");
    expect(workspace.tab.focused).toBe(2);
    expect(workspace.tab.root).toMatchObject({ children: [{}, { selected: 1 }] });
    press(workspace, "alt+s");
    expect(workspace.tab.focused).toBe(4);
    press(workspace, "ctrl+p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { panes: [3, 4, 5], selected: 2 }] });
    press(workspace, "alt+h", "ctrl+p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { panes: [3, 4, 5, 6], selected: 3 }] });
    press(workspace, "alt+h", "ctrl+p", "s");
    expect(workspace.tab.root).toMatchObject({ children: [{ kind: "tabs", panes: [2, 7], selected: 1 }, {}] });
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

  test("the project launcher opens every marked project and focuses the first", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "o");
    type(workspace, "pen ");
    press(workspace, "backspace", "backspace", "backspace");
    type(workspace, "mer ");
    expect(workspace.prompt?.text).toBe("mer");
    expect(workspace.prompt?.marked?.map((project) => project.name)).toEqual(["penguin", "merlin"]);
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin", "merlin"]);
    expect(workspace.tab.name).toBe("penguin");
  });

  test("the project launcher unmarks a project marked twice", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "o");
    type(workspace, "pen  ");
    expect(workspace.prompt?.marked).toEqual([]);
    press(workspace, "down", "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin-auth"]);
  });

  test("the project launcher switches to marked projects that already have tabs", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openProject("merlin");
    press(workspace, "ctrl+t", "h", "ctrl+t", "o");
    type(workspace, "merlin ");
    press(workspace, "backspace", "backspace", "backspace", "backspace", "backspace", "backspace");
    type(workspace, "pen ");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "merlin", "penguin"]);
    expect(workspace.tab.name).toBe("merlin");
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
    const clock = { now: 0 };
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    host.held.add(1);
    press(workspace, "ctrl+g", "return");
    expect(host.reruns).toEqual([1]);
    host.held.add(1);
    expect(workspace.focusedPaneHeld()).toBe(true);
    workspace.openPopup(workspace.reservePaneId(), "Question");
    clock.now += 2000;
    expect(workspace.focusedPaneHeld()).toBe(false);
  });

  test("a popup waits until the user stops typing before it takes the keys", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "h");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    clock.now += 500;
    expect(workspace.popup).toBeUndefined();
    expect(workspace.popupWaitMs()).toBe(1000);
    expect(press(workspace, "i")).toEqual([false]);
    clock.now += 1000;
    expect(workspace.popup).toBeUndefined();
    clock.now += 600;
    expect(workspace.popup?.title).toBe("Question");
    press(workspace, "y");
    expect(workspace.popup?.title).toBe("Question");
  });

  test("a view popup shows at once over its tab, ahead of waiting questions, without asking for attention", () => {
    const clock = { now: 0 };
    const host = new FakeHost();
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    press(workspace, "h");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    const view = workspace.reservePaneId();
    expect(workspace.openViewPopup(view, "Comments", 1, { width: 90, height: 90 })).toBe(workspace.tab.id);
    expect(workspace.popup).toMatchObject({ id: view, kind: "view", size: { width: 90, height: 90 } });
    expect(workspace.popupsWaiting(workspace.tab)).toBe(1);
    expect(press(workspace, "j")).toEqual([false]);
    workspace.popupExited(view);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.openViewPopup(workspace.reservePaneId(), "Nowhere", 99)).toBeUndefined();
  });

  test("a view popup held after a failure closes on the next key", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const view = workspace.reservePaneId();
    workspace.openViewPopup(view, "Comments", 1);
    expect(workspace.popupsWaiting(workspace.tab)).toBe(0);
    expect(workspace.tabAttention(workspace.tab)).toBeUndefined();
    host.held.add(view);
    expect(press(workspace, "x")).toEqual([true]);
    expect(host.destroyed).toEqual([view]);
    expect(workspace.popup).toBeUndefined();
  });

  test("Alt+a takes you to a question and shows it straight away", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "ctrl+t", "c");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    press(workspace, "alt+a");
    expect([workspace.active, workspace.tab.focused]).toEqual([0, 1]);
    expect(workspace.popup?.title).toBe("Question");
  });

  test("closing a pane in a pane-tab group keeps focus in the group", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+p", "r", "ctrl+p", "s", "ctrl+p", "s");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { kind: "tabs", panes: [2, 3, 4] }] });
    press(workspace, "alt+o", "ctrl+p", "x");
    expect(workspace.tab.focused).toBe(4);
  });

  test("Ctrl+t a goes back to the previous tab", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+t", "c", "ctrl+t", "c", "ctrl+t", "1");
    expect(workspace.active).toBe(0);
    press(workspace, "ctrl+t", "a");
    expect(workspace.active).toBe(2);
    press(workspace, "ctrl+t", "a");
    expect(workspace.active).toBe(0);
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
      expect(workspace.agents.get(3)).toBe("done");
      expect(workspace.setAgentState(1, "failed")).toBe(true);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
      expect(workspace.setAgentState(99, "done")).toBe(false);
    });

    test("Alt+a jumps to waiting agents first, then done ones, and typing clears done", () => {
      const workspace = twoTabs();
      workspace.setAgentState(1, "done");
      workspace.setAgentState(2, "waiting");
      press(workspace, "alt+a");
      expect([workspace.active, workspace.tab.focused]).toEqual([0, 2]);
      workspace.setAgentState(2, undefined);
      press(workspace, "alt+a");
      expect([workspace.active, workspace.tab.focused]).toEqual([0, 1]);
      expect(workspace.agents.get(1)).toBe("done");
      press(workspace, "x");
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

    test("a long command and an agent in one tab keep separate states", () => {
      const workspace = twoTabs();
      workspace.setAgentState(1, "working");
      expect(workspace.setCommandState(2, "running")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("working");
      expect(workspace.tabCommandState(workspace.tabs[0]!)).toBe("running");
      expect(workspace.setCommandState(2, "succeeded")).toBe(true);
      expect(workspace.agents.get(1)).toBe("working");
      press(workspace, "alt+a");
      expect([workspace.active, workspace.tab.focused]).toEqual([0, 2]);
      press(workspace, "x");
      expect(workspace.commands.has(2)).toBe(false);
      expect(workspace.agents.get(1)).toBe("working");
    });

    test("an exiting pane forgets its state", () => {
      const workspace = twoTabs();
      workspace.setAgentState(2, "waiting");
      workspace.setCommandState(2, "failed");
      workspace.paneExited(2);
      expect(workspace.agents.has(2)).toBe(false);
      expect(workspace.commands.has(2)).toBe(false);
    });
  });

  test("Ctrl+t w picks a tray widget to open", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+t", "w");
    expect(workspace.mode).toBe("tray");
    press(workspace, "s", "s", "s", "return");
    expect(host.openedWidgets).toEqual([1]);
    expect(workspace.mode).toBe("normal");
  });

  test("an empty tray cannot be entered", () => {
    const host = new FakeHost();
    host.widgets = 0;
    const workspace = new Workspace(host);
    press(workspace, "ctrl+t", "w");
    expect(workspace.mode).toBe("normal");
    expect(workspace.message).toBe("The tray has no widgets");
  });

  test("there is no resize mode", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+n")).toEqual([false]);
    expect(workspace.mode).toBe("normal");
  });
  describe("jobs", () => {
    function ide(clock: { now: number }, host = new FakeHost()) {
      const config = configSchema.parse({
        projects: { layout: "ide" },
        layouts: { ide: { row: [{ focus: true }, { tabs: [{ command: ["remax"] }, {}] }] } },
      });
      const workspace = new Workspace(host, "/home", config, () => clock.now);
      workspace.openProject("merlin");
      return { host, workspace };
    }

    test("Ctrl+s n runs a typed command out of sight and badges the tab while it runs", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      press(workspace, "ctrl+s", "n");
      type(workspace, "make test");
      press(workspace, "return");
      expect(host.jobs).toEqual([[5, ["sh", "-c", "make test"], workspace.tab.id]]);
      expect(workspace.tabJobs().map((job) => [job.name, job.state])).toEqual([["make test", "running"]]);
      expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
      expect(workspace.tabCommandState(workspace.tab)).toBe("running");
      expect(workspace.mode).toBe("normal");
    });

    test("a job that succeeds toasts for five seconds", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      const id = workspace.runJob(2, ["true"])!;
      clock.now = 3000;
      workspace.jobFinished(id, 0);
      expect(workspace.toasts()).toMatchObject([{ kind: "job", job: { state: "succeeded" } }]);
      expect(workspace.nextToastExpiry()).toBe(5000);
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      clock.now = 8000;
      expect(workspace.toasts()).toEqual([]);
      expect(workspace.nextToastExpiry()).toBeUndefined();
    });

    test("a tab keeps its five newest finished jobs, plus failures not yet looked at", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      const failed = workspace.runJob(2, ["false"], "failed")!;
      const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => workspace.runJob(2, ["true"], `ok ${n}`)!);
      clock.now = 1;
      workspace.jobFinished(failed, 1);
      for (const id of ids) {
        clock.now += 1;
        workspace.jobFinished(id, 0);
      }
      const running = workspace.runJob(2, ["sleep", "9"], "running")!;
      expect(workspace.tabJobs().map((job) => job.name)).toEqual(["failed", "ok 3", "ok 4", "ok 5", "ok 6", "ok 7", "running"]);
      workspace.openJob(failed);
      const last = workspace.runJob(2, ["true"], "last")!;
      clock.now += 1;
      workspace.jobFinished(last, 0);
      expect(workspace.tabJobs().map((job) => job.id)).toEqual([failed, ...ids.slice(3), running, last]);
    });

    test("a failed job stays toasted, badges its tab, and Alt a opens it", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const id = workspace.runJob(2, ["false"], "build")!;
      press(workspace, "ctrl+t", "c");
      workspace.jobFinished(id, 2);
      clock.now = 60_000;
      expect(workspace.toasts()).toMatchObject([{ kind: "job", job: { name: "build" }, tab: { name: "merlin" } }]);
      expect(workspace.tabCommandState(workspace.tabs[1]!)).toBe("failed");
      press(workspace, "alt+a");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.popup).toMatchObject({ id, kind: "job" });
      expect(workspace.toasts()).toEqual([]);
      host.held.add(id);
      press(workspace, "escape");
      expect(workspace.popup).toBeUndefined();
      expect(workspace.tabJobs()).toHaveLength(1);
    });

    test("a finished job's popup re-runs, moves into the layout, or closes", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const id = workspace.runJob(2, ["false"], "build")!;
      workspace.jobFinished(id, 1);
      workspace.openJob(id);
      host.held.add(id);
      press(workspace, "return");
      expect(host.reruns).toEqual([id]);
      expect(workspace.jobStatus(id)?.state).toBe("running");
      workspace.jobFinished(id, 1);
      host.held.add(id);
      press(workspace, "p");
      expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { kind: "tabs", panes: [3, 4, id] }] });
      expect(workspace.tab.focused).toBe(id);
      expect(workspace.paneNames.get(id)).toBe("build");
      expect(host.untracked).toEqual([id]);
      expect(workspace.jobs).toEqual([]);
      const other = workspace.runJob(2, ["false"])!;
      workspace.jobFinished(other, 1);
      workspace.openJob(other);
      host.held.add(other);
      press(workspace, "x");
      expect(host.destroyed).toContain(other);
      expect(workspace.jobs).toEqual([]);
      expect(workspace.popup).toBeUndefined();
    });

    test("jobs mode picks a job with the arrows and acts on it", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      workspace.runJob(2, ["one"]);
      const two = workspace.runJob(2, ["two"])!;
      press(workspace, "ctrl+s", "down", "r");
      expect(host.reruns).toEqual([]);
      expect(workspace.message).toBe("two is still running");
      workspace.jobFinished(two, 1);
      press(workspace, "r");
      expect(host.reruns).toEqual([two]);
      press(workspace, "return");
      expect(workspace.popup?.id).toBe(two);
      press(workspace, "ctrl+s", "h");
      expect(workspace.popup).toBeUndefined();
      press(workspace, "ctrl+s", "x");
      expect(workspace.selectedJob).toBe(0);
      expect(workspace.tabJobs().map((job) => job.name)).toEqual(["one"]);
    });

    test("Ctrl+s b sends a pane running a command to the background until the command finishes", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      press(workspace, "ctrl+s", "b");
      expect(workspace.message).toBe("Nothing is running in this pane");
      press(workspace, "alt+s", "alt+e");
      host.running.set(4, "cargo build");
      press(workspace, "ctrl+s", "b");
      expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { id: 3 }] });
      expect(workspace.tab.focused).toBe(3);
      expect(host.tracked).toEqual([4]);
      expect(workspace.tabJobs().map((job) => [job.name, job.command])).toEqual([["cargo build", undefined]]);
      workspace.jobFinished(4, 0);
      expect(workspace.jobStatus(4)?.state).toBe("succeeded");
      workspace.openJob(4);
      press(workspace, "return");
      expect(workspace.message).toBe("Only jobs started from a command can re-run");
      press(workspace, "escape");
      expect(workspace.popup).toBeUndefined();
      workspace.openJob(4);
      press(workspace, "p");
      expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
      expect(workspace.tab.focused).toBe(4);
    });

    test("an agent running as a job badges its tab, owns its popups, and is found by Alt a and Alt c", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const claude = workspace.runJob(2, ["qmux", "claude"], "claude")!;
      expect(workspace.tabCommandState(workspace.tab)).toBe("running");
      workspace.markAgent(claude);
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      workspace.setAgentState(claude, "working");
      expect(workspace.tabAttention(workspace.tab)).toBe("working");
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      press(workspace, "ctrl+t", "c");
      expect(workspace.setAgentState(claude, "done")).toBe(true);
      expect(workspace.openPopup(90, "Allow Write?", claude)).toBe(true);
      expect(workspace.popups.at(-1)?.tabId).toBe(workspace.tabs.find((tab) => tab.name === "merlin")!.id);
      workspace.popupExited(90);
      press(workspace, "alt+a");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
      expect(workspace.agents.has(claude)).toBe(false);
      workspace.setAgentState(claude, "waiting");
      press(workspace, "x");
      expect(workspace.agents.get(claude)).toBe("working");
      press(workspace, "ctrl+s", "h");
      host.claudes.add(claude);
      press(workspace, "alt+c");
      expect(host.composed).toEqual([claude]);
      const tests = workspace.runJob(claude, ["bun", "test"])!;
      expect(workspace.jobStatus(tests)?.tabId).toBe(workspace.tab.id);
      workspace.setAgentState(claude, "done");
      workspace.closeJob(claude);
      expect(workspace.agents.has(claude)).toBe(false);
    });

    test("the last pane in a tab can't go to the background", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host);
      host.running.set(1, "sleep 30");
      press(workspace, "ctrl+s", "b");
      expect(workspace.message).toBe("The tab's last pane can't go to the background");
      expect(workspace.jobs).toEqual([]);
    });

    test("a backgrounded pane's shell exiting drops the job, and closing a tab closes its jobs", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      host.running.set(2, "sleep 30");
      press(workspace, "ctrl+s", "b");
      workspace.paneExited(2);
      expect(workspace.jobs).toEqual([]);
      expect(workspace.message).toBe("sleep 30 ended");
      const id = workspace.runJob(3, ["sleep", "30"])!;
      workspace.paneExited(3);
      workspace.paneExited(4);
      expect(host.destroyed).toContain(id);
      expect(workspace.jobs).toEqual([]);
    });

    test("an agent job opened by Alt a hides once you reply and the agent gets back to work", () => {
      const { workspace } = ide({ now: 0 });
      const claude = workspace.runJob(2, ["qmux", "claude"], "claude")!;
      workspace.setAgentState(claude, "done");
      press(workspace, "alt+a");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
      workspace.setAgentState(claude, "working");
      expect(workspace.popup).toBeUndefined();
      workspace.setAgentState(claude, "done");
      press(workspace, "ctrl+s", "return");
      workspace.setAgentState(claude, "working");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
    });

    test("a dormant Claude job forgets that it was dormant when it closes", () => {
      const { workspace } = ide({ now: 0 });
      const claude = workspace.runJob(2, ["qmux", "claude"], "claude")!;
      workspace.dormant.add(claude);
      workspace.closeJob(claude);
      expect(workspace.dormant.has(claude)).toBe(false);
    });

    test("Alt j hides the open job, running or finished, and reopens the last one", () => {
      const { workspace } = ide({ now: 0 });
      press(workspace, "alt+j");
      expect(workspace.message).toBe("No job or question to reopen");
      const job = workspace.runJob(2, ["make"])!;
      press(workspace, "ctrl+s", "return");
      expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
      press(workspace, "alt+j");
      expect(workspace.popup).toBeUndefined();
      press(workspace, "alt+j");
      expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
      workspace.jobFinished(job, 1);
      press(workspace, "alt+j");
      expect(workspace.popup).toBeUndefined();
      const merlin = workspace.tab;
      press(workspace, "ctrl+t", "c", "alt+j");
      expect(workspace.tab).not.toBe(merlin);
      expect(workspace.popup).toBeUndefined();
      expect(workspace.message).toBe("No job or question to reopen");
    });

    test("Alt p switches to the reply's tab, and Alt x dismisses the oldest reply toast", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const merlin = workspace.tab;
      const agent = merlin.focused;
      const other = paneIds(merlin.root).find((id) => id !== agent)!;
      press(workspace, "ctrl+t", "c");
      workspace.setAgentState(agent, "done", "first");
      clock.now = 10;
      workspace.setAgentState(other, "done", "second");
      press(workspace, "alt+x");
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", id: other }]);
      press(workspace, "alt+p");
      expect(workspace.tab).toBe(merlin);
      expect(host.peeked.map(([id]) => id)).toEqual([other]);
      expect(press(workspace, "alt+x")).toEqual([false]);
    });

    test("Alt a shows an agent's question where you are, then peeks at unread replies", () => {
      const { host, workspace } = ide({ now: 5 });
      const [first, second] = paneIds(workspace.tab.root) as [number, number];
      press(workspace, "ctrl+t", "c");
      const merlin = workspace.tabs.find((tab) => tab.name === "merlin")!;
      workspace.setAgentState(first, "done", "Which one?");
      expect(workspace.openPopup(90, "Allow Write?", second)).toBe(true);
      press(workspace, "alt+j", "alt+a");
      expect([workspace.tab.name, workspace.popup?.id]).toEqual(["merlin", 90]);
      expect(workspace.tab.focused).toBe(first);
      workspace.popupExited(90);
      workspace.active = 0;
      press(workspace, "alt+a");
      expect(host.peeked).toEqual([[first, "Claude · merlin", "Which one?"]]);
      expect(workspace.tab).toBe(merlin);
    });

    test("an agent's reply is unread until its pane is seen or peeked at", () => {
      const { host, workspace } = ide({ now: 5 });
      const agent = workspace.tab.focused;
      workspace.setAgentState(agent, "done", "Seen as it came");
      expect(workspace.toasts()).toEqual([]);
      press(workspace, "alt+s");
      workspace.setAgentState(agent, "done", "**Built** it\nmore");
      expect(workspace.tabUnread(workspace.tab)).toBe(true);
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", id: agent, reply: { text: "**Built** it\nmore" } }]);
      press(workspace, "alt+p");
      expect(host.peeked).toEqual([[agent, "Claude · merlin", "**Built** it\nmore"]]);
      expect(workspace.toasts()).toEqual([]);
      expect(workspace.agents.has(agent)).toBe(false);
      workspace.setAgentState(agent, "done", "Again");
      press(workspace, "alt+h");
      expect(workspace.tabUnread(workspace.tab)).toBe(false);
      const empty = new Workspace(new FakeHost());
      press(empty, "alt+p");
      expect(empty.message).toBe("No agent reply to show");
    });

    test("Ctrl+t R rebuilds the tab from its layout after you type its name", () => {
      const host = new FakeHost();
      const config = configSchema.parse({
        projects: { layout: "up" },
        layouts: { up: { row: [{ focus: true }, { command: ["remax"] }], jobs: [{ command: ["scripts/up"] }] } },
      });
      const workspace = new Workspace(host, "/home", config, () => 0);
      workspace.openProject("merlin");
      const tab = workspace.tab;
      const before = paneIds(tab.root);
      const layoutJob = tab.layoutRuns.get(0)!;
      const adHoc = workspace.runJob(tab.focused, ["make"])!;
      press(workspace, "ctrl+p", "r");
      press(workspace, "ctrl+t", "shift+r", "x", "return");
      expect(workspace.message).toBe("Left the tab running");
      press(workspace, "ctrl+t", "shift+r", ..."merlin".split(""), "return");
      expect(workspace.tab).toBe(tab);
      expect(host.destroyed).toEqual(expect.arrayContaining([...before, layoutJob, adHoc]));
      expect(paneIds(tab.root)).toHaveLength(2);
      expect(paneIds(tab.root).some((id) => before.includes(id))).toBe(false);
      expect(paneIds(tab.root).map((id) => host.commands.get(id))).toEqual([undefined, ["remax"]]);
      expect(workspace.tabJobs(tab).map((job) => job.command)).toEqual([["scripts/up"]]);
    });

    test("closing the last tab with several jobs closes them all", () => {
      const { host, workspace } = ide({ now: 0 });
      const first = workspace.tab.name;
      press(workspace, "ctrl+t", "c");
      const jobs = [workspace.runJob(workspace.tab.focused, ["one"])!, workspace.runJob(workspace.tab.focused, ["two"])!];
      press(workspace, "ctrl+t", "x", ...workspace.tab.name.split(""), "return");
      expect(host.destroyed).toEqual(expect.arrayContaining(jobs));
      expect(workspace.jobs).toEqual([]);
      expect(workspace.tab.name).toBe(first);
    });
  });

  test("Alt j hides an open question and brings it back; Alt a shows it too", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openPopup(50, "Deploy?");
    expect(workspace.popup?.id).toBe(50);
    press(workspace, "alt+j");
    expect(workspace.popup).toBeUndefined();
    expect(workspace.hiddenAsks().map((popup) => popup.id)).toEqual([50]);
    expect(workspace.tabAttention(workspace.tab)).toBe("waiting");
    expect(press(workspace, "x")).toEqual([false]);
    press(workspace, "alt+j");
    expect(workspace.popup?.id).toBe(50);
    press(workspace, "alt+j", "alt+a");
    expect(workspace.popup?.id).toBe(50);
    workspace.popupExited(50);
    expect(workspace.hiddenAsks()).toEqual([]);
  });

  test("Alt keys reach qmux over every kind of popup", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const agent = workspace.tab.focused;
    workspace.setAgentState(agent, "done", "Built it");
    workspace.openPopup(50, "Deploy?");
    expect(press(workspace, "alt+p", "alt+h")).toEqual([true, false]);
    expect(host.peeked.map(([id]) => id)).toEqual([agent]);
    workspace.openViewPopup(60, "peek", agent);
    expect(press(workspace, "alt+x", "alt+j")).toEqual([false, true]);
    expect(host.destroyed).toContain(60);
    expect(workspace.popup?.id).toBe(50);
    workspace.popupExited(50);
    const job = workspace.runJob(agent, ["make"])!;
    press(workspace, "ctrl+s", "return");
    expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
    workspace.jobFinished(job, 0);
    expect(press(workspace, "alt+a")).toEqual([true]);
  });

  test("Alt c messages the focused native Claude, or the tab's first one", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "alt+c");
    expect(workspace.message).toBe("No native Claude in this tab");
    press(workspace, "ctrl+p", "r");
    host.claudes.add(1);
    press(workspace, "alt+c");
    expect(host.composed).toEqual([1]);
    expect(workspace.message).toBeUndefined();
    host.claudes.add(2);
    press(workspace, "alt+c");
    expect(host.composed).toEqual([1, 2]);
    expect(workspace.tab.focused).toBe(2);
  });

  test("Ctrl+s reaches an ask popup, so forms can submit, but opens jobs mode over a job", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openPopup(50, "Question");
    expect(press(workspace, "ctrl+s")).toEqual([false]);
    expect(workspace.mode).toBe("normal");
    workspace.popupExited(50);
    const job = workspace.runJob(1, ["sleep", "5"])!;
    workspace.openJob(job);
    press(workspace, "ctrl+s");
    expect(workspace.mode).toBe("jobs");
  });
});
