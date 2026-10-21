import { addToFirstStack, expandPane, growPane, leaf, neighbor, paneIds, paneRects, removePane, shrinkPane, splitPane, stackPane, type Axis, type LayoutNode, type PaneId } from "./layout.ts";
import { defaultConfig, planLayout, type Config, type LayoutSpec } from "./config.ts";
import { keyName, lookup, type Command, type Key, type Mode } from "./keymap.ts";
import { expandHome, rankProjects, resolveTarget, type Project } from "./projects.ts";

export type Tab = { id: number; name: string; root: LayoutNode; focused: PaneId; zoomed: boolean };

export type Popup = { id: PaneId; title: string };

export type Prompt = {
  kind: "rename-tab" | "rename-pane" | "close-tab" | "open-project";
  label: string;
  text: string;
  candidates?: Project[];
  matches?: Project[];
};

export interface PaneHost {
  create(id: PaneId, cwd: string | undefined, command?: string[]): void;
  projects(): Project[];
  destroy(id: PaneId): void;
  closePopup(id: PaneId): void;
  isHeld(id: PaneId): boolean;
  rerun(id: PaneId): void;
  replaceWithShell(id: PaneId): void;
  cwd(id: PaneId): string | undefined;
  screen(): { cols: number; rows: number };
}

export type InputKey = Key & { sequence: string };

const resizeStep = 0.05;
const shownMatches = 6;

export class Workspace {
  tabs: Tab[] = [];
  active = 0;
  mode: Mode = "normal";
  prompt: Prompt | undefined;
  message: string | undefined;
  quit = false;
  detachRequested = false;
  clients = 1;
  readonly paneNames = new Map<PaneId, string>();
  readonly popups: Popup[] = [];
  private nextPaneId = 1;
  private nextTabNumber = 1;

  constructor(
    private readonly host: PaneHost,
    initialCwd?: string,
    private readonly config: Config = defaultConfig,
  ) {
    this.openTab(initialCwd);
  }

  get tab(): Tab {
    return this.tabs[this.active]!;
  }

  get popup(): Popup | undefined {
    return this.popups[0];
  }

  reservePaneId(): PaneId {
    return this.nextPaneId++;
  }

  openPopup(id: PaneId, title: string): void {
    this.popups.push({ id, title });
  }

  popupExited(id: PaneId): void {
    const index = this.popups.findIndex((popup) => popup.id === id);
    if (index >= 0) this.popups.splice(index, 1);
  }

  handleKey(key: InputKey): boolean {
    try {
      return this.dispatchKey(key);
    } finally {
      this.expandFocused();
    }
  }

  private expandFocused(): void {
    for (const tab of this.tabs) tab.root = expandPane(tab.root, tab.focused);
  }

  private dispatchKey(key: InputKey): boolean {
    this.message = undefined;
    if (this.popup && this.mode !== "session" && !(keyName(key) === "ctrl+o")) return false;
    if (this.prompt) {
      this.editPrompt(key);
      return true;
    }
    const binding = lookup(this.mode, key);
    if (binding) {
      this.run(binding.command);
      if (binding.then) this.mode = binding.then;
      return true;
    }
    if (this.mode === "normal" && this.host.isHeld(this.tab.focused)) return this.heldKey(key);
    return this.mode !== "normal" && this.mode !== "locked";
  }

  focusedPaneHeld(): boolean {
    return this.host.isHeld(this.tab.focused);
  }

  private heldKey(key: InputKey): boolean {
    const id = this.tab.focused;
    switch (keyName(key)) {
      case "return":
        this.host.rerun(id);
        break;
      case "escape":
        this.host.replaceWithShell(id);
        break;
      case "ctrl+c":
        this.host.destroy(id);
        this.paneExited(id);
        break;
    }
    return true;
  }

  focusPane(id: PaneId): void {
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(id));
    if (index < 0) return;
    this.active = index;
    this.tab.focused = id;
    this.expandFocused();
  }

  openProject(target: string): string | undefined {
    const project = resolveTarget(target.trim(), this.host.cwd(this.tab.focused) ?? process.cwd(), this.host.projects());
    if (!project) return `No project matches ${JSON.stringify(target.trim())}`;
    const existing = this.tabs.findIndex((tab) => tab.name === project.name);
    if (existing >= 0) {
      this.active = existing;
      return undefined;
    }
    const layout = this.config.projects.layout ? this.config.layouts[this.config.projects.layout] : undefined;
    this.openTab(project.dir, { name: project.name, layout });
    return undefined;
  }

  paneExited(id: PaneId): void {
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(id));
    if (index < 0) return;
    this.paneNames.delete(id);
    const tab = this.tabs[index]!;
    const root = removePane(tab.root, id);
    if (root === null) return this.removeTab(index);
    tab.root = root;
    if (tab.focused === id) tab.focused = paneIds(root)[0]!;
    tab.zoomed = false;
    this.expandFocused();
  }

  private run(command: Command): void {
    switch (command.type) {
      case "mode":
        this.mode = command.mode;
        return;
      case "focus": {
        const target = neighbor(this.tab.root, this.tab.focused, command.direction);
        if (target !== undefined) Object.assign(this.tab, { focused: target, zoomed: false });
        return;
      }
      case "cycle-pane": {
        const ids = paneIds(this.tab.root);
        this.tab.focused = ids[wrap(ids.indexOf(this.tab.focused) + command.delta, ids.length)]!;
        return;
      }
      case "new-pane":
        return this.newPane(command.axis);
      case "stack-pane":
        return this.addPane((root, focused, id) => stackPane(root, focused, id));
      case "close-pane": {
        const id = this.tab.focused;
        this.host.destroy(id);
        return this.paneExited(id);
      }
      case "zoom":
        this.tab.zoomed = !this.tab.zoomed;
        return;
      case "rename-pane":
        this.prompt = { kind: "rename-pane", label: "Rename pane", text: this.paneNames.get(this.tab.focused) ?? "" };
        return;
      case "new-tab":
        return this.openTab(this.config.defaultCwd ? expandHome(this.config.defaultCwd) : this.host.cwd(this.tab.focused));
      case "open-project": {
        const candidates = this.host.projects();
        this.prompt = { kind: "open-project", label: "Open project", text: "", candidates, matches: candidates.slice(0, shownMatches) };
        return;
      }
      case "close-tab":
        this.prompt = { kind: "close-tab", label: `Type "${this.tab.name}" to close this tab`, text: "" };
        return;
      case "rename-tab":
        this.prompt = { kind: "rename-tab", label: "Rename tab", text: this.tab.name };
        return;
      case "cycle-tab":
        this.active = wrap(this.active + command.delta, this.tabs.length);
        return;
      case "move-tab":
        return this.moveTab(command.delta);
      case "go-to-tab":
        if (command.index < this.tabs.length) this.active = command.index;
        return;
      case "resize":
        this.tab.root = (command.shrink ? shrinkPane : growPane)(this.tab.root, this.tab.focused, command.direction, resizeStep);
        return;
      case "detach":
        this.detachRequested = true;
        return;
      case "close-popup":
        if (this.popup) this.host.closePopup(this.popup.id);
        else this.message = "No popup is open";
        return;
      case "quit":
        this.quit = true;
        return;
    }
  }

  private newPane(axis: Axis | undefined): void {
    this.addPane((root, focused, id) =>
      (axis === undefined ? addToFirstStack(root, id) : undefined) ?? splitPane(root, focused, axis ?? this.preferredAxis(this.tab), id),
    );
  }

  private addPane(place: (root: LayoutNode, focused: PaneId, id: PaneId) => LayoutNode): void {
    const tab = this.tab;
    const id = this.nextPaneId++;
    tab.root = place(tab.root, tab.focused, id);
    const cwd = this.host.cwd(tab.focused);
    tab.focused = id;
    tab.zoomed = false;
    this.host.create(id, cwd);
  }

  private preferredAxis(tab: Tab): Axis {
    const rect = paneRects(tab.root).get(tab.focused)!;
    const { cols, rows } = this.host.screen();
    return rect.width * cols > rect.height * rows * 2.2 ? "row" : "column";
  }

  private openTab(cwd: string | undefined, options: { name?: string; layout?: LayoutSpec } = {}): void {
    const number = this.nextTabNumber++;
    const plan = planLayout(options.layout ?? {}, () => this.nextPaneId++);
    const tab: Tab = { id: number, name: options.name ?? `Tab #${number}`, root: plan.root, focused: plan.focus, zoomed: false };
    this.tabs.splice(this.tabs.length === 0 ? 0 : this.active + 1, 0, tab);
    this.active = this.tabs.length === 1 ? 0 : this.active + 1;
    for (const pane of plan.panes) {
      if (pane.name) this.paneNames.set(pane.id, pane.name);
      this.host.create(pane.id, cwd, pane.command);
    }
  }

  private moveTab(delta: number): void {
    const target = this.active + delta;
    if (target < 0 || target >= this.tabs.length) return;
    const [tab] = this.tabs.splice(this.active, 1);
    this.tabs.splice(target, 0, tab!);
    this.active = target;
  }

  private removeTab(index: number): void {
    this.tabs.splice(index, 1);
    if (this.tabs.length === 0) {
      this.quit = true;
      return;
    }
    if (this.active > index || this.active >= this.tabs.length) this.active = Math.max(this.active - 1, 0);
  }

  private closeTab(): void {
    const index = this.active;
    for (const id of paneIds(this.tab.root)) {
      this.host.destroy(id);
      this.paneNames.delete(id);
    }
    this.removeTab(index);
  }

  private editPrompt(key: InputKey): void {
    const prompt = this.prompt!;
    if (key.name === "escape") {
      this.prompt = undefined;
      return;
    }
    if (key.name === "return") {
      this.prompt = undefined;
      return this.commitPrompt(prompt);
    }
    if (key.name === "backspace") prompt.text = prompt.text.slice(0, -1);
    else if (key.name === "tab" && prompt.matches?.[0]) prompt.text = prompt.matches[0].name;
    else if (!key.ctrl && !key.meta && isPrintable(key.sequence)) prompt.text += key.sequence;
    if (prompt.candidates) prompt.matches = rankProjects(prompt.text, prompt.candidates).slice(0, shownMatches);
  }

  private commitPrompt(prompt: Prompt): void {
    const text = prompt.text.trim();
    switch (prompt.kind) {
      case "rename-tab":
        if (text) this.tab.name = text;
        return;
      case "rename-pane":
        if (text) this.paneNames.set(this.tab.focused, text);
        else this.paneNames.delete(this.tab.focused);
        return;
      case "close-tab":
        if (prompt.text === this.tab.name) return this.closeTab();
        this.message = "Kept the tab";
        return;
      case "open-project": {
        const target = text || prompt.matches?.[0]?.name;
        if (target) this.message = this.openProject(target);
        return;
      }
    }
  }
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function isPrintable(sequence: string): boolean {
  return sequence.length > 0 && [...sequence].every((char) => char >= " " && char !== "\x7f");
}
