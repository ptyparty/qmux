import { addToFirstTabs, selectPaneTab, leaf, neighbor, paneIds, paneRects, removePane, splitPane, addPaneTab, type Axis, type LayoutNode, type PaneId } from "./layout.ts";
import { defaultConfig, planLayout, type Config, type LayoutSpec } from "./config.ts";
import { keyName, lookup, type Command, type Key, type Mode } from "./keymap.ts";
import { expandHome, looksLikePath, rankProjects, resolveTarget, type Project } from "./projects.ts";

export type Tab = { id: number; name: string; root: LayoutNode; focused: PaneId; zoomed: boolean };

export type Popup = { id: PaneId; title: string; tabId: number };

export const agentStates = ["working", "waiting", "done"] as const;
export type AgentState = (typeof agentStates)[number];

const urgency: Record<AgentState, number> = { waiting: 3, done: 2, working: 1 };

export type Prompt = {
  kind: "rename-tab" | "rename-pane" | "close-tab" | "open-project";
  title: string;
  detail?: string;
  text: string;
  candidates?: Project[];
  matches?: Project[];
  selected: number;
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

const popupPassthrough = new Set(["ctrl+t", "ctrl+o"]);
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
  readonly agents = new Map<PaneId, AgentState>();
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
    return this.popups.find((popup) => popup.tabId === this.tab.id);
  }

  popupsWaiting(tab: Tab): number {
    return this.popups.filter((popup) => popup.tabId === tab.id).length;
  }

  reservePaneId(): PaneId {
    return this.nextPaneId++;
  }

  openPopup(id: PaneId, title: string, askingPane?: PaneId): void {
    const owner = this.tabs.find((tab) => askingPane !== undefined && paneIds(tab.root).includes(askingPane)) ?? this.tab;
    this.popups.push({ id, title, tabId: owner.id });
  }

  popupExited(id: PaneId): void {
    const index = this.popups.findIndex((popup) => popup.id === id);
    if (index >= 0) this.popups.splice(index, 1);
  }

  handleKey(key: InputKey): boolean {
    try {
      return this.dispatchKey(key);
    } finally {
      this.selectFocusedTabs();
    }
  }

  private selectFocusedTabs(): void {
    for (const tab of this.tabs) tab.root = selectPaneTab(tab.root, tab.focused);
    const focused = this.tabs[this.active]?.focused;
    if (focused !== undefined && this.agents.get(focused) === "done") this.agents.delete(focused);
  }

  setAgentState(id: PaneId, state: AgentState | undefined): boolean {
    if (!this.tabs.some((tab) => paneIds(tab.root).includes(id))) return false;
    if (state === undefined) {
      this.agents.delete(id);
      return false;
    }
    const watching = id === this.tab.focused;
    if (state === "done" && watching) {
      this.agents.delete(id);
      return false;
    }
    const changed = this.agents.get(id) !== state;
    this.agents.set(id, state);
    return changed && !watching && state !== "working";
  }

  tabAttention(tab: Tab): AgentState | undefined {
    let most: AgentState | undefined;
    for (const id of paneIds(tab.root)) {
      const state = this.agents.get(id);
      if (state && (!most || urgency[state] > urgency[most])) most = state;
    }
    return most;
  }

  private jumpToAttention(): void {
    const order = this.tabs.flatMap((tab, index) => paneIds(tab.root).map((id) => ({ index, id })));
    const start = order.findIndex((entry) => entry.index === this.active && entry.id === this.tab.focused);
    const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)];
    const target =
      rotated.find((entry) => this.agents.get(entry.id) === "waiting") ?? rotated.find((entry) => this.agents.get(entry.id) === "done");
    if (!target) {
      this.message = "No agent needs you";
      return;
    }
    this.active = target.index;
    this.tab.focused = target.id;
  }

  private dispatchKey(key: InputKey): boolean {
    this.message = undefined;
    const consumed = this.routeKey(key);
    if (!consumed && !this.popup && this.agents.get(this.tab.focused) === "waiting") this.agents.set(this.tab.focused, "working");
    return consumed;
  }

  private routeKey(key: InputKey): boolean {
    if (this.popup && this.mode === "normal" && !popupPassthrough.has(keyName(key))) return false;
    if (this.prompt) {
      this.editPrompt(key);
      return true;
    }
    const binding = lookup(this.mode, key);
    if (binding) {
      const before = `${this.active}:${this.tab.focused}`;
      const mode = this.mode;
      this.run(binding.command);
      if (binding.then) this.mode = binding.then;
      if (mode === "normal" && this.tabs.length > 0 && before !== `${this.active}:${this.tab.focused}` && !this.message) {
        this.message = `Focus moved by ${keyLabel(keyName(key))}`;
      }
      return true;
    }
    if ((this.mode === "normal" || this.mode === "locked") && this.host.isHeld(this.tab.focused)) return this.heldKey(key);
    return this.mode !== "normal" && this.mode !== "locked";
  }

  focusedPaneHeld(): boolean {
    return !this.popup && !this.prompt && this.host.isHeld(this.tab.focused);
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
    this.selectFocusedTabs();
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
    this.agents.delete(id);
    const tab = this.tabs[index]!;
    const root = removePane(tab.root, id);
    if (root === null) return this.removeTab(index);
    tab.root = root;
    if (tab.focused === id) tab.focused = paneIds(root)[0]!;
    tab.zoomed = false;
    this.selectFocusedTabs();
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
      case "tab-pane":
        return this.addPane((root, focused, id) => addPaneTab(root, focused, id));
      case "close-pane": {
        const id = this.tab.focused;
        this.host.destroy(id);
        return this.paneExited(id);
      }
      case "zoom":
        this.tab.zoomed = !this.tab.zoomed;
        return;
      case "rename-pane":
        this.prompt = { kind: "rename-pane", title: "Rename pane", text: this.paneNames.get(this.tab.focused) ?? "", selected: 0 };
        return;
      case "new-tab":
        return this.openTab(this.config.defaultCwd ? expandHome(this.config.defaultCwd) : this.host.cwd(this.tab.focused));
      case "open-project": {
        const candidates = this.host.projects();
        this.prompt = { kind: "open-project", title: "Open project", text: "", candidates, matches: candidates.slice(0, shownMatches), selected: 0 };
        return;
      }
      case "close-tab":
        this.prompt = { kind: "close-tab", title: "Close tab", detail: `Type "${this.tab.name}" to close it`, text: "", selected: 0 };
        return;
      case "rename-tab":
        this.prompt = { kind: "rename-tab", title: "Rename tab", text: this.tab.name, selected: 0 };
        return;
      case "cycle-tab":
        this.active = wrap(this.active + command.delta, this.tabs.length);
        return;
      case "move-tab":
        return this.moveTab(command.delta);
      case "go-to-tab":
        if (command.index < this.tabs.length) this.active = command.index;
        return;
      case "detach":
        this.detachRequested = true;
        return;
      case "next-attention":
        return this.jumpToAttention();
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
      (axis === undefined ? addToFirstTabs(root, id) : undefined) ?? splitPane(root, focused, axis ?? this.preferredAxis(this.tab), id),
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
    const matches = prompt.matches ?? [];
    if (key.name === "up" || key.name === "down") {
      if (matches.length > 0) prompt.selected = (prompt.selected + (key.name === "up" ? -1 : 1) + matches.length) % matches.length;
      return;
    }
    if (key.name === "tab") {
      const selected = matches[prompt.selected];
      if (selected) prompt.text = selected.name;
    } else if (key.name === "backspace") prompt.text = prompt.text.slice(0, -1);
    else if (!key.ctrl && !key.meta && isPrintable(key.sequence)) prompt.text += key.sequence;
    else return;
    if (prompt.candidates) {
      prompt.matches = rankProjects(prompt.text, prompt.candidates).slice(0, shownMatches);
      prompt.selected = 0;
    }
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
        const target = looksLikePath(text) ? text : (prompt.matches?.[prompt.selected]?.name ?? text);
        if (target) this.message = this.openProject(target);
        return;
      }
    }
  }
}

function keyLabel(name: string): string {
  return name
    .split("+")
    .map((part) => (part.length > 1 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("+");
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function isPrintable(sequence: string): boolean {
  return sequence.length > 0 && [...sequence].every((char) => char >= " " && char !== "\x7f");
}
