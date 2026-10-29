import { addToFirstTabs, inPaneTabs, selectPaneTab, leaf, neighbor, paneIds, paneRects, paneTabSibling, removePane, splitPane, addPaneTab, type Axis, type LayoutNode, type PaneId } from "./layout.ts";
import { defaultConfig, namedTabs, planLayout, projectLayout, type Config, type LayoutEntry } from "./config.ts";
import { keyName, lookup, type Command, type Key, type Mode } from "./keymap.ts";
import { expandHome, looksLikePath, rankProjects, resolveTarget, type Project } from "./projects.ts";

export type Tab = { id: number; name: string; root: LayoutNode; focused: PaneId; zoomed: boolean };

export type PopupSize = { width: number; height: number };
export type Popup = { id: PaneId; title: string; tabId: number; kind: "ask" | "view" | "job"; askingPane?: PaneId; size?: PopupSize };

export type JobState = "running" | "succeeded" | "failed";
export type Job = { id: PaneId; tabId: number; name: string; command?: string[]; state: JobState; code?: number | null; started: number; finished?: number; seen: boolean; agent?: boolean; dock: boolean; layout?: boolean };
export type Reply = { text: string; at: number; unread: boolean };
export type Toast = { kind: "job"; job: Job; tab: Tab } | { kind: "reply"; id: PaneId; reply: Reply; tab: Tab };

export const agentStates = ["working", "waiting", "done", "failed"] as const;
export type AgentState = (typeof agentStates)[number];

export type CommandState = "running" | "succeeded" | "failed";

const urgency: Record<AgentState, number> = { waiting: 4, failed: 3, done: 2, working: 1 };
const commandUrgency: Record<CommandState, number> = { failed: 3, succeeded: 2, running: 1 };
const popupDelayMs = 1500;
const toastMs = 5000;

export type Prompt = {
  kind: "rename-tab" | "rename-pane" | "close-tab" | "open-project" | "run-job";
  title: string;
  detail?: string;
  text: string;
  candidates?: Project[];
  matches?: Project[];
  marked?: Project[];
  selected: number;
};

export type PanePlacement = "right" | "below" | "tab";

export interface PaneHost {
  create(id: PaneId, cwd: string | undefined, command: string[] | undefined, tabId: number): void;
  createJob(id: PaneId, cwd: string | undefined, command: string[], tabId: number, env?: Record<string, string>): void;
  trackJob(id: PaneId, tabId: number): void;
  untrackJob(id: PaneId): void;
  runningCommand(id: PaneId): string | undefined;
  shellCommand(text: string): string[];
  composeClaude(near: PaneId, candidates: PaneId[]): string | undefined;
  peekReply(near: PaneId, title: string, text: string): void;
  tabClosed(tabId: number): void;
  projects(): Project[];
  destroy(id: PaneId): void;
  closePopup(id: PaneId): void;
  isHeld(id: PaneId): boolean;
  rerun(id: PaneId): void;
  replaceWithShell(id: PaneId): void;
  cwd(id: PaneId): string | undefined;
  screen(): { cols: number; rows: number };
  widgetCount(): number;
  openWidget(index: number): void;
}

export type InputKey = Key & { sequence: string };

const popupPassthrough = new Set(["ctrl+t", "ctrl+o"]);
const jobPopupPassthrough = new Set([...popupPassthrough, "ctrl+s", "alt+j"]);

export class Workspace {
  tabs: Tab[] = [];
  active = 0;
  mode: Mode = "normal";
  prompt: Prompt | undefined;
  message: string | undefined;
  quit = false;
  detachRequested = false;
  clients = 1;
  selectedWidget = 0;
  readonly paneNames = new Map<PaneId, string>();
  readonly popups: Popup[] = [];
  readonly agents = new Map<PaneId, AgentState>();
  readonly replies = new Map<PaneId, Reply>();
  readonly activities = new Map<PaneId, string>();
  private readonly hideOnReply = new Set<PaneId>();
  private lastJob: PaneId | undefined;
  private peeking = false;
  readonly commands = new Map<PaneId, CommandState>();
  readonly jobs: Job[] = [];
  selectedJob = 0;
  private nextPaneId = 1;
  private nextTabNumber = 1;
  private lastKeyAt = Number.NEGATIVE_INFINITY;
  private readonly shownPopups = new Set<PaneId>();
  private currentTabId: number | undefined;
  private previousTabId: number | undefined;

  constructor(
    private readonly host: PaneHost,
    initialCwd?: string,
    private readonly config: Config = defaultConfig,
    private readonly now: () => number = Date.now,
  ) {
    const startup = namedTabs(config).filter((tab) => config.startup.includes(tab.name));
    startup.sort((a, b) => config.startup.indexOf(a.name) - config.startup.indexOf(b.name));
    if (startup.length === 0) this.openTab(initialCwd);
    for (const tab of startup) this.openTab(tab.dir, { name: tab.name, layout: projectLayout(config, tab) });
    this.active = 0;
    this.selectFocusedTabs();
  }

  get tab(): Tab {
    return this.tabs[this.active]!;
  }

  get popup(): Popup | undefined {
    const view = this.popups.find((candidate) => candidate.tabId === this.tab.id && candidate.kind !== "ask");
    if (view) return view;
    const popup = this.popups.find((candidate) => candidate.tabId === this.tab.id);
    if (!popup) return undefined;
    if (!this.shownPopups.has(popup.id) && this.popupDelayLeft(popup) > 0) return undefined;
    this.shownPopups.add(popup.id);
    return popup;
  }

  popupWaitMs(): number | undefined {
    const popup = this.popups.find((candidate) => candidate.tabId === this.tab.id);
    if (!popup || popup.kind !== "ask" || this.shownPopups.has(popup.id)) return undefined;
    return Math.max(this.popupDelayLeft(popup), 0);
  }

  private popupDelayLeft(_popup: Popup): number {
    return this.lastKeyAt + popupDelayMs - this.now();
  }

  popupsWaiting(tab: Tab): number {
    return this.popups.filter((popup) => popup.tabId === tab.id && popup.kind === "ask").length;
  }

  reservePaneId(): PaneId {
    return this.nextPaneId++;
  }

  tabPanes(tab: Tab): PaneId[] {
    return [...paneIds(tab.root), ...this.tabJobs(tab).map((job) => job.id)];
  }

  tabOf(id: PaneId | undefined): Tab | undefined {
    if (id === undefined) return undefined;
    return this.tabs.find((tab) => this.tabPanes(tab).includes(id));
  }

  openPopup(id: PaneId, title: string, askingPane?: PaneId): boolean {
    const owner = this.tabOf(askingPane) ?? this.tab;
    this.popups.push({ id, title, tabId: owner.id, kind: "ask", askingPane });
    return owner !== this.tab || (askingPane !== undefined && askingPane !== this.tab.focused);
  }

  openViewPopup(id: PaneId, title: string, near: PaneId, size?: PopupSize): number | undefined {
    const owner = this.tabOf(near);
    if (!owner) return undefined;
    this.popups.push({ id, title, tabId: owner.id, kind: "view", size });
    return owner.id;
  }

  popupExited(id: PaneId): void {
    const index = this.popups.findIndex((popup) => popup.id === id);
    if (index >= 0) this.popups.splice(index, 1);
    this.shownPopups.delete(id);
    this.hideOnReply.delete(id);
  }

  handleKey(key: InputKey): boolean {
    if (!this.popup) this.lastKeyAt = this.now();
    try {
      return this.dispatchKey(key);
    } finally {
      this.selectFocusedTabs();
    }
  }

  private selectFocusedTabs(): void {
    for (const tab of this.tabs) tab.root = selectPaneTab(tab.root, tab.focused);
    const id = this.tabs[this.active]?.id;
    if (id !== this.currentTabId) {
      this.previousTabId = this.currentTabId;
      this.currentTabId = id;
    }
  }

  setAgentState(id: PaneId, state: AgentState | undefined, reply?: string): boolean {
    if (!this.tabOf(id)) return false;
    if (state === undefined) {
      this.agents.delete(id);
      return false;
    }
    this.markAgent(id);
    if (state === "working" && this.hideOnReply.has(id)) this.popupExited(id);
    const watching = id === this.tab.focused || this.popup?.id === id;
    if (reply !== undefined) {
      this.replies.delete(id);
      this.replies.set(id, { text: reply, at: this.now(), unread: !watching });
    }
    const changed = this.agents.get(id) !== state;
    this.agents.set(id, state);
    return changed && !watching && state !== "working";
  }

  setCommandState(id: PaneId, state: CommandState): boolean {
    if (!this.tabs.some((tab) => paneIds(tab.root).includes(id))) return false;
    const changed = this.commands.get(id) !== state;
    this.commands.set(id, state);
    return changed && id !== this.tab.focused && state !== "running";
  }

  tabCommandState(tab: Tab): CommandState | undefined {
    const states = [...paneIds(tab.root).map((id) => this.commands.get(id)), ...this.tabJobs(tab).map(jobBadge)];
    let most: CommandState | undefined;
    for (const state of states) if (state && (!most || commandUrgency[state] > commandUrgency[most])) most = state;
    return most;
  }

  tabJobs(tab: Tab = this.tab): Job[] {
    return this.jobs.filter((job) => job.tabId === tab.id);
  }

  toasts(): Toast[] {
    const now = this.now();
    const jobs = this.jobs.flatMap((job): Toast[] => {
      const tab = this.tabs.find((candidate) => candidate.id === job.tabId);
      if (!tab || job.seen || job.state === "running") return [];
      if (job.state === "succeeded" && now - job.finished! >= toastMs) return [];
      return [{ kind: "job", job, tab }];
    });
    const replies = [...this.replies].flatMap(([id, reply]): Toast[] => {
      const tab = this.tabOf(id);
      return tab && reply.unread ? [{ kind: "reply", id, reply, tab }] : [];
    });
    return [...jobs, ...replies];
  }

  tabUnread(tab: Tab): boolean {
    return this.tabPanes(tab).some((id) => this.replies.get(id)?.unread);
  }

  seeReply(id: PaneId): void {
    const reply = this.replies.get(id);
    if (reply) reply.unread = false;
  }

  nextToastExpiry(): number | undefined {
    const left = this.toasts()
      .flatMap((toast) => (toast.kind === "job" && toast.job.state === "succeeded" ? [toast.job.finished! + toastMs - this.now()] : []));
    return left.length > 0 ? Math.max(Math.min(...left), 0) : undefined;
  }

  runJob(near: PaneId, command: string[], name?: string, from: { cwd?: string; env?: Record<string, string>; dock?: boolean } = {}): PaneId | undefined {
    const tab = this.tabOf(near);
    if (!tab) return undefined;
    const id = this.nextPaneId++;
    this.host.createJob(id, from.cwd ?? this.host.cwd(near), command, tab.id, from.env);
    this.jobs.push({ id, tabId: tab.id, name: name ?? command.join(" "), command, state: "running", started: this.now(), seen: false, dock: from.dock ?? false });
    return id;
  }

  jobFinished(id: PaneId, code: number | null): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.state !== "running") return;
    Object.assign(job, { state: code === 0 ? "succeeded" : "failed", code, finished: this.now(), seen: this.popup?.id === id });
  }

  markAgent(id: PaneId): void {
    const job = this.jobStatus(id);
    if (job) job.agent = true;
  }

  jobStatus(id: PaneId): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  openJob(id: PaneId): void {
    const job = this.jobStatus(id);
    const index = this.tabs.findIndex((tab) => tab.id === job?.tabId);
    if (!job || index < 0) return;
    this.active = index;
    if (!this.popups.some((popup) => popup.id === id)) this.popups.push({ id, title: job.name, tabId: job.tabId, kind: "job" });
    this.lastJob = id;
    if (job.state !== "running") job.seen = true;
    this.acknowledge(id);
  }

  closeJob(id: PaneId): void {
    this.host.destroy(id);
    this.forgetJob(id);
  }

  private forgetJob(id: PaneId): void {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index >= 0) this.jobs.splice(index, 1);
    this.popupExited(id);
    this.paneNames.delete(id);
    this.agents.delete(id);
    this.replies.delete(id);
    this.activities.delete(id);
    this.commands.delete(id);
    this.selectedJob = Math.max(Math.min(this.selectedJob, this.tabJobs().length - 1), 0);
  }

  private rerunJob(job: Job): void {
    if (!job.command) {
      this.message = "Only jobs started from a command can re-run";
      return;
    }
    if (job.state === "running") {
      this.message = `${job.name} is still running`;
      return;
    }
    this.host.rerun(job.id);
    Object.assign(job, { state: "running", code: undefined, started: this.now(), finished: undefined, seen: false });
  }

  private promoteJob(job: Job): void {
    const index = this.tabs.findIndex((tab) => tab.id === job.tabId);
    if (index < 0) return;
    const tab = this.tabs[index]!;
    const name = job.name;
    const [agent, reply] = [this.agents.get(job.id), this.replies.get(job.id)];
    this.forgetJob(job.id);
    if (agent) this.agents.set(job.id, agent);
    if (reply) this.replies.set(job.id, reply);
    this.host.untrackJob(job.id);
    this.paneNames.set(job.id, name);
    tab.root = this.placeNew(tab, job.id, undefined);
    Object.assign(tab, { focused: job.id, zoomed: false });
    this.active = index;
  }

  private backgroundPane(): void {
    const tab = this.tab;
    const id = tab.focused;
    const running = this.host.runningCommand(id);
    if (running === undefined) {
      this.message = "Nothing is running in this pane";
      return;
    }
    const root = removePane(tab.root, id);
    if (root === null) {
      this.message = "The tab's last pane can't go to the background";
      return;
    }
    const sibling = paneTabSibling(tab.root, id);
    tab.root = root;
    tab.focused = sibling ?? paneIds(root)[0]!;
    tab.zoomed = false;
    this.commands.delete(id);
    this.jobs.push({ id, tabId: tab.id, name: this.paneNames.get(id) ?? running, state: "running", started: this.now(), seen: false, dock: false });
    this.host.trackJob(id, tab.id);
  }

  private currentJob(): Job | undefined {
    const popup = this.popup;
    if (popup?.kind === "job") return this.jobStatus(popup.id);
    const jobs = this.tabJobs();
    return jobs[Math.min(this.selectedJob, jobs.length - 1)];
  }

  private withJob(act: (job: Job) => void): void {
    const job = this.currentJob();
    if (job) act(job);
    else this.message = "This tab has no jobs";
  }

  private finishedJobKey(id: PaneId, key: InputKey): boolean {
    const job = this.jobStatus(id);
    if (!job) return true;
    switch (keyName(key)) {
      case "return":
        this.rerunJob(job);
        break;
      case "p":
        this.promoteJob(job);
        break;
      case "x":
        this.closeJob(id);
        break;
      case "escape":
        this.popupExited(id);
        break;
    }
    return true;
  }

  tabAttention(tab: Tab): AgentState | undefined {
    if (this.popupsWaiting(tab) > 0) return "waiting";
    let most: AgentState | undefined;
    for (const id of this.tabPanes(tab)) {
      const state = this.agents.get(id);
      if (state && (!most || urgency[state] > urgency[most])) most = state;
    }
    return most;
  }

  private jumpToAttention(): void {
    const order = this.tabs.flatMap((tab, index) => this.tabPanes(tab).map((id) => ({ index, id })));
    const start = order.findIndex((entry) => entry.index === this.active && entry.id === this.tab.focused);
    const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)];
    const asks = this.popups.filter((popup) => popup.kind === "ask");
    const asking = new Set(asks.map((popup) => popup.askingPane ?? this.tabs.find((tab) => tab.id === popup.tabId)?.focused));
    const needs = (id: PaneId) => asking.has(id) || this.agents.get(id) === "waiting";
    const finished = (id: PaneId) => this.agents.get(id) === "done" || this.agents.get(id) === "failed" || this.commandFinished(id);
    const target = rotated.find((entry) => needs(entry.id));
    const failedJob = this.jobs.find((job) => job.state === "failed" && !job.seen);
    if (!target && failedJob) return this.openJob(failedJob.id);
    const done = target ?? rotated.find((entry) => finished(entry.id));
    if (!done) {
      this.message = "No agent needs you";
      return;
    }
    this.active = done.index;
    if (!this.jobStatus(done.id)) this.tab.focused = done.id;
    else if (!asking.has(done.id)) {
      this.openJob(done.id);
      if (this.jobStatus(done.id)?.agent) this.hideOnReply.add(done.id);
    }
    this.lastKeyAt = Number.NEGATIVE_INFINITY;
  }

  private dispatchKey(key: InputKey): boolean {
    this.message = undefined;
    const consumed = this.routeKey(key);
    const shown = this.peeking ? undefined : this.popup?.kind === "job" ? this.popup.id : this.popup ? undefined : this.tabs[this.active]?.focused;
    this.peeking = false;
    if (shown !== undefined) this.seeReply(shown);
    if (!consumed && !this.popup) this.acknowledge(this.tab.focused);
    else if (!consumed && this.popup?.kind === "job") this.acknowledge(this.popup.id);
    return consumed;
  }

  private peekReply(): void {
    const replies = [...this.replies].filter(([id]) => this.tabOf(id));
    const newest = (candidates: typeof replies) => candidates.sort(([, a], [, b]) => b.at - a.at)[0];
    const target =
      replies.find(([id]) => id === this.tab.focused) ??
      newest(replies.filter(([, reply]) => reply.unread)) ??
      newest(replies.filter(([id]) => this.tabOf(id) === this.tab));
    if (!target) {
      this.message = "No agent reply to show";
      return;
    }
    const [id, reply] = target;
    const tab = this.tabOf(id)!;
    this.active = this.tabs.indexOf(tab);
    for (const popup of this.popups.filter((candidate) => candidate.tabId === tab.id && candidate.kind === "job")) this.popupExited(popup.id);
    this.peeking = true;
    this.host.peekReply(id, `${this.paneNames.get(id) ?? "Claude"} · ${tab.name}`, reply.text);
    reply.unread = false;
    this.acknowledge(id);
  }

  private replyToasts(): Reply[] {
    return this.toasts().flatMap((toast) => (toast.kind === "reply" ? [toast.reply] : []));
  }

  private dismissReply(): void {
    const oldest = this.replyToasts()[0];
    if (oldest) oldest.unread = false;
  }

  private acknowledge(id: PaneId): void {
    const state = this.agents.get(id);
    if (state === "waiting") this.agents.set(id, "working");
    if (state === "done" || state === "failed") this.agents.delete(id);
    if (this.commandFinished(id)) this.commands.delete(id);
  }

  private commandFinished(id: PaneId): boolean {
    const state = this.commands.get(id);
    return state === "succeeded" || state === "failed";
  }

  private routeKey(key: InputKey): boolean {
    if (this.prompt) {
      this.editPrompt(key);
      return true;
    }
    const popup = this.popup;
    const passthrough = popup?.kind === "job" ? jobPopupPassthrough : popupPassthrough;
    const finishedJob = popup?.kind === "job" && this.jobStatus(popup.id)?.state !== "running";
    if (finishedJob && this.mode === "normal" && !passthrough.has(keyName(key))) {
      return this.finishedJobKey(popup!.id, key);
    }
    if (popup?.kind === "view" && this.host.isHeld(popup.id)) {
      this.host.destroy(popup.id);
      this.popupExited(popup.id);
      return true;
    }
    if (popup && this.mode === "normal" && !passthrough.has(keyName(key))) return false;
    const binding = lookup(this.mode, key);
    if (binding?.command.type === "dismiss-reply" && this.replyToasts().length === 0) return false;
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
    this.seeReply(id);
    this.selectFocusedTabs();
  }

  openProject(target: string): string | undefined {
    const project = resolveTarget(target.trim(), this.host.cwd(this.tab.focused) ?? process.cwd(), this.projects());
    if (!project) return `No project matches ${JSON.stringify(target.trim())}`;
    this.showProject(project);
    this.selectFocusedTabs();
    return undefined;
  }

  private openProjects(projects: Project[]): void {
    let first: number | undefined;
    for (const project of projects) {
      this.showProject(project);
      first ??= this.active;
    }
    if (first !== undefined) this.active = first;
    this.selectFocusedTabs();
  }

  private showProject(project: Project): void {
    const existing = this.tabs.findIndex((tab) => tab.name === project.name);
    if (existing >= 0) this.active = existing;
    else this.openTab(project.dir, { name: project.name, layout: projectLayout(this.config, project) });
  }

  openPaneNear(near: PaneId, placement: PanePlacement, command: string[], options: { name?: string; focus?: boolean } = {}): PaneId | undefined {
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(near));
    if (index < 0) return undefined;
    const tab = this.tabs[index]!;
    const id = this.nextPaneId++;
    tab.root = placement === "tab" ? addPaneTab(tab.root, near, id) : splitPane(tab.root, near, placement === "right" ? "row" : "column", id);
    tab.zoomed = false;
    if (options.name) this.paneNames.set(id, options.name);
    this.host.create(id, this.host.cwd(near), command, tab.id);
    if (options.focus ?? true) {
      this.active = index;
      tab.focused = id;
    }
    this.selectFocusedTabs();
    return id;
  }

  private projects(): Project[] {
    const named = namedTabs(this.config);
    const names = new Set(named.map((tab) => tab.name));
    return [...named, ...this.host.projects().filter((project) => !names.has(project.name))];
  }

  paneExited(id: PaneId): void {
    const job = this.jobStatus(id);
    if (job) {
      this.forgetJob(id);
      if (job.state === "running") this.message = `${job.name} ended`;
      return;
    }
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(id));
    if (index < 0) return;
    this.paneNames.delete(id);
    this.agents.delete(id);
    this.replies.delete(id);
    this.commands.delete(id);
    const tab = this.tabs[index]!;
    const sibling = paneTabSibling(tab.root, id);
    const root = removePane(tab.root, id);
    if (root === null) return this.removeTab(index);
    tab.root = root;
    if (tab.focused === id) tab.focused = sibling ?? paneIds(root)[0]!;
    tab.zoomed = false;
    this.selectFocusedTabs();
  }

  private run(command: Command): void {
    switch (command.type) {
      case "mode":
        if (command.mode === "tray" && this.host.widgetCount() === 0) {
          this.message = "The tray has no widgets";
          this.mode = "normal";
          return;
        }
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
        const candidates = this.projects();
        this.prompt = { kind: "open-project", title: "Open project", text: "", candidates, matches: candidates, marked: [], selected: 0 };
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
      case "peek-reply":
        return this.peekReply();
      case "dismiss-reply":
        return this.dismissReply();
      case "toggle-job": {
        const popup = this.popup;
        if (popup?.kind === "job") return this.popupExited(popup.id);
        if (this.lastJob !== undefined && this.jobStatus(this.lastJob)) return this.openJob(this.lastJob);
        this.message = "No job to reopen";
        return;
      }
      case "compose-claude":
        this.message = this.host.composeClaude(this.tab.focused, this.tabPanes(this.tab));
        return;
      case "last-tab": {
        const index = this.tabs.findIndex((tab) => tab.id === this.previousTabId);
        if (index >= 0) this.active = index;
        else this.message = "No previous tab";
        return;
      }
      case "select-widget":
        this.selectedWidget = wrap(this.selectedWidget + command.delta, this.host.widgetCount());
        return;
      case "open-widget":
        if (this.selectedWidget < this.host.widgetCount()) this.host.openWidget(this.selectedWidget);
        return;
      case "close-popup":
        if (this.popup) this.host.closePopup(this.popup.id);
        else this.message = "No popup is open";
        return;
      case "run-job":
        this.prompt = { kind: "run-job", title: "Run job", detail: "Runs out of sight; a toast says when it's done", text: "", selected: 0 };
        return;
      case "background-pane":
        return this.backgroundPane();
      case "select-job": {
        const count = this.tabJobs().length;
        if (count > 0) this.selectedJob = wrap(this.selectedJob + command.delta, count);
        return;
      }
      case "open-job":
        return this.withJob((job) => this.openJob(job.id));
      case "hide-job":
        return this.withJob((job) => this.popupExited(job.id));
      case "rerun-job":
        return this.withJob((job) => this.rerunJob(job));
      case "dock-job":
        return this.withJob((job) => {
          job.dock = !job.dock;
        });
      case "promote-job":
        return this.withJob((job) => this.promoteJob(job));
      case "close-job":
        return this.withJob((job) => this.closeJob(job.id));
      case "quit":
        this.quit = true;
        return;
    }
  }

  private newPane(axis: Axis | undefined): void {
    this.addPane((_root, _focused, id) => this.placeNew(this.tab, id, axis));
  }

  private placeNew(tab: Tab, id: PaneId, axis: Axis | undefined): LayoutNode {
    const { root, focused } = tab;
    const grouped = axis === undefined ? (inPaneTabs(root, focused) ? addPaneTab(root, focused, id) : addToFirstTabs(root, id)) : undefined;
    return grouped ?? splitPane(root, focused, axis ?? this.preferredAxis(tab), id);
  }

  private addPane(place: (root: LayoutNode, focused: PaneId, id: PaneId) => LayoutNode): void {
    const tab = this.tab;
    const id = this.nextPaneId++;
    tab.root = place(tab.root, tab.focused, id);
    const cwd = this.host.cwd(tab.focused);
    tab.focused = id;
    tab.zoomed = false;
    this.host.create(id, cwd, undefined, tab.id);
  }

  private preferredAxis(tab: Tab): Axis {
    const rect = paneRects(tab.root).get(tab.focused)!;
    const { cols, rows } = this.host.screen();
    return rect.width * cols > rect.height * rows * 2.2 ? "row" : "column";
  }

  private openTab(cwd: string | undefined, options: { name?: string; layout?: LayoutEntry } = {}): void {
    const number = this.nextTabNumber++;
    const plan = planLayout(options.layout?.layout ?? {}, () => this.nextPaneId++);
    const tab: Tab = { id: number, name: options.name ?? `Tab #${number}`, root: plan.root, focused: plan.focus, zoomed: false };
    this.tabs.splice(this.tabs.length === 0 ? 0 : this.active + 1, 0, tab);
    this.active = this.tabs.length === 1 ? 0 : this.active + 1;
    for (const pane of plan.panes) {
      if (pane.name) this.paneNames.set(pane.id, pane.name);
      this.host.create(pane.id, cwd, pane.command, tab.id);
    }
    for (const job of options.layout?.jobs ?? []) {
      const id = this.runJob(tab.focused, job.command, job.name, { cwd, dock: job.dock });
      const started = id === undefined ? undefined : this.jobStatus(id);
      if (started) started.layout = true;
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
    for (const job of this.tabJobs(this.tabs[index])) this.closeJob(job.id);
    const [removed] = this.tabs.splice(index, 1);
    this.host.tabClosed(removed!.id);
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
      this.agents.delete(id);
      this.replies.delete(id);
      this.commands.delete(id);
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
    if (prompt.marked && key.sequence === " ") {
      const selected = matches[prompt.selected];
      if (selected) prompt.marked = toggleMark(prompt.marked, selected);
      return;
    }
    if (key.name === "tab") {
      const selected = matches[prompt.selected];
      if (selected) prompt.text = selected.name;
    } else if (key.name === "backspace") prompt.text = prompt.text.slice(0, -1);
    else if (!key.ctrl && !key.meta && isPrintable(key.sequence)) prompt.text += key.sequence;
    else return;
    if (prompt.candidates) {
      prompt.matches = rankProjects(prompt.text, prompt.candidates);
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
      case "run-job":
        if (text) this.runJob(this.tab.focused, this.host.shellCommand(text), text);
        return;
      case "close-tab":
        if (prompt.text === this.tab.name) return this.closeTab();
        this.message = "Kept the tab";
        return;
      case "open-project": {
        if (prompt.marked && prompt.marked.length > 0) return this.openProjects(prompt.marked);
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

function jobBadge(job: Job): CommandState | undefined {
  if (job.state === "running") return job.agent || job.layout || job.dock ? undefined : "running";
  return job.state === "failed" && !job.seen ? "failed" : undefined;
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function toggleMark(marked: Project[], project: Project): Project[] {
  return marked.some((mark) => mark.dir === project.dir) ? marked.filter((mark) => mark.dir !== project.dir) : [...marked, project];
}

function isPrintable(sequence: string): boolean {
  return sequence.length > 0 && [...sequence].every((char) => char >= " " && char !== "\x7f");
}
