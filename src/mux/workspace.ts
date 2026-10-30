import { addToFirstTabs, inPaneTabs, selectPaneTab, leaf, neighbor, paneIds, paneRects, paneTabSibling, removePane, splitPane, swapPanes, addPaneTab, type Axis, type Direction, type LayoutNode, type PaneId } from "./layout.ts";
import { defaultConfig, namedTabs, planLayout, projectLayout, type Config, type DrawerSpec, type JobSpec, type LayoutEntry, type LayoutSpec } from "./config.ts";
import { keyName, lookup, type Command, type Key, type Mode } from "./keymap.ts";
import { expandHome, looksLikePath, rankProjects, resolveTarget, type Project } from "./projects.ts";

export type Drawer = { id: PaneId; height: number; open: boolean; zoomed: boolean };
export type Tab = { id: number; name: string; root: LayoutNode; layoutFocus: PaneId; zoomed: boolean; layout: LayoutSpec; layoutJobs: JobSpec[]; layoutRuns: Map<number, PaneId>; cwd?: string; drawerSpec?: DrawerSpec; drawer?: Drawer };

export type PopupSize = { width: number; height: number };
export type Popup = { id: PaneId; title: string; tabId: number; kind: "ask" | "view" | "job"; askingPane?: PaneId; size?: PopupSize; hidden?: boolean };

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
const keptFinishedJobs = 5;
const drawerHeights = { initial: 40, step: 10, min: 20, max: 80 };

export type Prompt = {
  kind: "rename-tab" | "rename-pane" | "close-tab" | "restart-tab" | "open-project" | "run-job";
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

const popupPassthrough = new Set(["ctrl+t", "ctrl+o", "alt+x", "alt+a", "alt+p", "alt+c", "alt+j"]);
const jobPopupPassthrough = new Set([...popupPassthrough, "ctrl+s"]);

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
  readonly modes = new Map<PaneId, string>();
  readonly dormant = new Set<PaneId>();
  private readonly hideOnReply = new Set<PaneId>();
  private readonly lastJobs = new Map<number, PaneId>();
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

  get focused(): PaneId {
    return focusedPane(this.tab);
  }

  drawerOf(tab: Tab = this.tab): Drawer | undefined {
    return tab.drawer?.open ? tab.drawer : undefined;
  }

  get popup(): Popup | undefined {
    const view = this.popups.find((candidate) => candidate.tabId === this.tab.id && candidate.kind !== "ask");
    if (view) return view;
    const popup = this.popups.find((candidate) => candidate.tabId === this.tab.id && !candidate.hidden);
    if (!popup) return undefined;
    if (!this.shownPopups.has(popup.id) && this.popupDelayLeft(popup) > 0) return undefined;
    this.shownPopups.add(popup.id);
    return popup;
  }

  hiddenAsks(tab: Tab = this.tab): Popup[] {
    return this.popups.filter((popup) => popup.tabId === tab.id && popup.kind === "ask" && popup.hidden);
  }

  popupWaitMs(): number | undefined {
    const popup = this.popups.find((candidate) => candidate.tabId === this.tab.id && !candidate.hidden);
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
    return [...paneIds(tab.root), ...(tab.drawer ? [tab.drawer.id] : []), ...this.tabJobs(tab).map((job) => job.id)];
  }

  tabOf(id: PaneId | undefined): Tab | undefined {
    if (id === undefined) return undefined;
    return this.tabs.find((tab) => this.tabPanes(tab).includes(id));
  }

  openPopup(id: PaneId, title: string, askingPane?: PaneId): boolean {
    const owner = this.tabOf(askingPane) ?? this.tab;
    this.popups.push({ id, title, tabId: owner.id, kind: "ask", askingPane });
    return owner !== this.tab || (askingPane !== undefined && askingPane !== this.focused);
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
    for (const tab of this.tabs) tab.root = selectPaneTab(tab.root, tab.layoutFocus);
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
    const watching = id === this.focused || this.popup?.id === id;
    if (reply !== undefined) {
      this.replies.delete(id);
      this.replies.set(id, { text: reply, at: this.now(), unread: !watching });
    }
    const changed = this.agents.get(id) !== state;
    this.agents.set(id, state);
    return changed && !watching && state !== "working";
  }

  setCommandState(id: PaneId, state: CommandState): boolean {
    if (!this.tabs.some((tab) => ownPanes(tab).includes(id))) return false;
    const changed = this.commands.get(id) !== state;
    this.commands.set(id, state);
    return changed && id !== this.focused && state !== "running";
  }

  tabCommandState(tab: Tab): CommandState | undefined {
    const states = [...ownPanes(tab).map((id) => this.commands.get(id)), ...this.tabJobs(tab).map(jobBadge)];
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
    this.pruneFinishedJobs(job.tabId);
  }

  private pruneFinishedJobs(tabId: number): void {
    const open = new Set(this.popups.map((popup) => popup.id));
    const finished = this.jobs
      .filter((job) => job.tabId === tabId && job.state !== "running" && !job.dock && !job.layout && !job.agent)
      .sort((a, b) => b.finished! - a.finished!);
    for (const job of finished.slice(keptFinishedJobs)) {
      if (!open.has(job.id) && (job.state === "succeeded" || job.seen)) this.closeJob(job.id);
    }
  }

  markAgent(id: PaneId, agent = true): void {
    const job = this.jobStatus(id);
    if (job) job.agent = agent;
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
    this.lastJobs.set(job.tabId, id);
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
    this.forgetPane(id);
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
    this.modes.delete(job.id);
    Object.assign(job, { state: "running", code: undefined, started: this.now(), finished: undefined, seen: false, agent: false });
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
    Object.assign(tab, { layoutFocus: job.id, zoomed: false });
    this.leaveDrawer(tab);
    this.active = index;
  }

  private backgroundPane(): void {
    const tab = this.tab;
    if (this.drawerOf(tab)) {
      this.message = "The drawer can't go to the background";
      return;
    }
    const id = tab.layoutFocus;
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
    tab.layoutFocus = sibling ?? paneIds(root)[0]!;
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
    const start = order.findIndex((entry) => entry.index === this.active && entry.id === this.focused);
    const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)];
    const asks = this.popups.filter((popup) => popup.kind === "ask");
    const asking = new Set(asks.map((popup) => popup.askingPane ?? focusedPaneOf(this.tabs.find((tab) => tab.id === popup.tabId))));
    const needs = (id: PaneId) => asking.has(id) || this.agents.get(id) === "waiting";
    const finished = (id: PaneId) => this.agents.get(id) === "done" || this.agents.get(id) === "failed" || this.commandFinished(id);
    const ask = rotated.find((entry) => asking.has(entry.id));
    if (ask) {
      this.active = ask.index;
      for (const hidden of this.hiddenAsks()) hidden.hidden = false;
      this.lastKeyAt = Number.NEGATIVE_INFINITY;
      return;
    }
    const waiting = rotated.find((entry) => needs(entry.id));
    if (waiting) return this.goToAgent(waiting);
    const failedJob = this.jobs.find((job) => job.state === "failed" && !job.seen);
    if (failedJob) return this.openJob(failedJob.id);
    const replied = rotated.find((entry) => this.replies.get(entry.id)?.unread);
    if (replied) return this.peekAt(replied.id);
    const done = rotated.find((entry) => finished(entry.id));
    if (!done) {
      this.message = "No agent needs you";
      return;
    }
    this.goToAgent(done);
  }

  private goToAgent(entry: { index: number; id: PaneId }): void {
    this.active = entry.index;
    if (entry.id === this.tab.drawer?.id) this.showDrawer(this.tab);
    else if (!this.jobStatus(entry.id)) {
      this.tab.layoutFocus = entry.id;
      this.leaveDrawer(this.tab);
    } else {
      this.openJob(entry.id);
      if (this.jobStatus(entry.id)?.agent) this.hideOnReply.add(entry.id);
    }
    this.lastKeyAt = Number.NEGATIVE_INFINITY;
  }

  private dispatchKey(key: InputKey): boolean {
    this.message = undefined;
    const consumed = this.routeKey(key);
    const shown = this.peeking ? undefined : this.popup?.kind === "job" ? this.popup.id : this.popup ? undefined : this.tabs.length > 0 ? this.focused : undefined;
    this.peeking = false;
    if (shown !== undefined) this.seeReply(shown);
    if (!consumed && !this.popup) this.acknowledge(this.focused);
    else if (!consumed && this.popup?.kind === "job") this.acknowledge(this.popup.id);
    return consumed;
  }

  private peekReply(): void {
    const replies = [...this.replies].filter(([id]) => this.tabOf(id));
    const newest = (candidates: typeof replies) => candidates.sort(([, a], [, b]) => b.at - a.at)[0];
    const target =
      replies.find(([id]) => id === this.focused) ??
      newest(replies.filter(([, reply]) => reply.unread)) ??
      newest(replies.filter(([id]) => this.tabOf(id) === this.tab));
    if (!target) {
      this.message = "No agent reply to show";
      return;
    }
    this.peekAt(target[0]);
  }

  private peekAt(id: PaneId): void {
    const reply = this.replies.get(id);
    const tab = this.tabOf(id);
    if (!reply || !tab) return;
    this.active = this.tabs.indexOf(tab);
    for (const popup of this.popups.filter((candidate) => candidate.tabId === tab.id && candidate.kind === "job")) this.popupExited(popup.id);
    this.peeking = true;
    this.host.peekReply(id, `${this.paneNames.get(id) ?? "Claude"} · ${tab.name}`, reply.text);
    reply.unread = false;
    this.acknowledge(id);
  }

  private dismissToast(): void {
    const toast = this.toasts()[0];
    if (toast?.kind === "job") toast.job.seen = true;
    if (toast?.kind === "reply") toast.reply.unread = false;
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
    if (binding?.command.type === "dismiss-toast" && this.toasts().length === 0) return false;
    if (binding) {
      this.run(binding.command);
      if (binding.then) this.mode = binding.then;
      return true;
    }
    if ((this.mode === "normal" || this.mode === "locked") && this.host.isHeld(this.focused)) return this.heldKey(key);
    return this.mode !== "normal" && this.mode !== "locked";
  }

  focusedPaneHeld(): boolean {
    return !this.popup && !this.prompt && this.host.isHeld(this.focused);
  }

  private heldKey(key: InputKey): boolean {
    const id = this.focused;
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
    const drawer = this.tabs.findIndex((tab) => tab.drawer?.id === id);
    if (drawer >= 0) {
      this.active = drawer;
      this.showDrawer(this.tab);
      this.seeReply(id);
      return this.selectFocusedTabs();
    }
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(id));
    if (index < 0) return;
    this.active = index;
    this.tab.layoutFocus = id;
    this.leaveDrawer(this.tab);
    this.seeReply(id);
    this.selectFocusedTabs();
  }

  openProject(target: string, withJobs = true): string | undefined {
    const project = resolveTarget(target.trim(), this.host.cwd(this.focused) ?? process.cwd(), this.projects());
    if (!project) return `No project matches ${JSON.stringify(target.trim())}`;
    this.showProject(project, withJobs);
    this.selectFocusedTabs();
    return undefined;
  }

  private openProjects(projects: Project[], withJobs: boolean): void {
    let first: number | undefined;
    for (const project of projects) {
      this.showProject(project, withJobs);
      first ??= this.active;
    }
    if (first !== undefined) this.active = first;
    this.selectFocusedTabs();
  }

  private showProject(project: Project, withJobs = true): void {
    const existing = this.tabs.findIndex((tab) => tab.name === project.name);
    if (existing >= 0) this.active = existing;
    else this.openTab(project.dir, { name: project.name, layout: projectLayout(this.config, project), withJobs });
  }

  openPaneNear(near: PaneId, placement: PanePlacement, command: string[], options: { name?: string; focus?: boolean } = {}): PaneId | undefined {
    const index = this.tabs.findIndex((tab) => ownPanes(tab).includes(near));
    if (index < 0) return undefined;
    const tab = this.tabs[index]!;
    const id = this.nextPaneId++;
    const anchor = near === tab.drawer?.id ? tab.layoutFocus : near;
    tab.root = placement === "tab" ? addPaneTab(tab.root, anchor, id) : splitPane(tab.root, anchor, placement === "right" ? "row" : "column", id);
    tab.zoomed = false;
    if (options.name) this.paneNames.set(id, options.name);
    this.host.create(id, this.host.cwd(near), command, tab.id);
    if (options.focus ?? true) {
      this.active = index;
      tab.layoutFocus = id;
      this.leaveDrawer(tab);
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
    const owner = this.tabs.find((tab) => tab.drawer?.id === id);
    if (owner) {
      this.forgetDrawer(owner);
      return;
    }
    const index = this.tabs.findIndex((tab) => paneIds(tab.root).includes(id));
    if (index < 0) return;
    this.forgetPane(id);
    const tab = this.tabs[index]!;
    const sibling = paneTabSibling(tab.root, id);
    const root = removePane(tab.root, id);
    if (root === null) return this.removeTab(index);
    tab.root = root;
    if (tab.layoutFocus === id) tab.layoutFocus = sibling ?? paneIds(root)[0]!;
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
        if (command.mode === "resize" && !this.drawerOf()) {
          this.message = "The drawer isn't open";
          this.mode = "normal";
          return;
        }
        this.mode = command.mode;
        return;
      case "focus":
        return this.moveFocus(command.direction);
      case "swap-pane": {
        if (this.drawerOf()) return;
        const target = neighbor(this.tab.root, this.tab.layoutFocus, command.direction);
        if (target !== undefined) Object.assign(this.tab, { root: swapPanes(this.tab.root, this.tab.layoutFocus, target), zoomed: false });
        return;
      }
      case "cycle-pane": {
        if (this.drawerOf()) return this.leaveDrawer(this.tab);
        const ids = paneIds(this.tab.root);
        this.tab.layoutFocus = ids[wrap(ids.indexOf(this.tab.layoutFocus) + command.delta, ids.length)]!;
        return;
      }
      case "new-pane":
        return this.newPane(command.axis);
      case "tab-pane":
        return this.addPane((root, focused, id) => addPaneTab(root, focused, id));
      case "close-pane": {
        const id = this.focused;
        this.host.destroy(id);
        return this.paneExited(id);
      }
      case "zoom": {
        const drawer = this.drawerOf();
        if (drawer) drawer.zoomed = !drawer.zoomed;
        else this.tab.zoomed = !this.tab.zoomed;
        return;
      }
      case "rename-pane":
        this.prompt = { kind: "rename-pane", title: "Rename pane", text: this.paneNames.get(this.focused) ?? "", selected: 0 };
        return;
      case "new-tab":
        return this.openTab(this.config.defaultCwd ? expandHome(this.config.defaultCwd) : this.host.cwd(this.focused));
      case "open-project": {
        const candidates = this.projects();
        this.prompt = { kind: "open-project", title: "Open project", text: "", candidates, matches: candidates, marked: [], selected: 0 };
        return;
      }
      case "restart-tab":
        this.prompt = { kind: "restart-tab", title: "Restart tab", detail: `Type "${this.tab.name}" to rebuild it from its layout`, text: "", selected: 0 };
        return;
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
      case "dismiss-toast":
        return this.dismissToast();
      case "toggle-job": {
        const popup = this.popup;
        if (popup?.kind === "job") return this.popupExited(popup.id);
        if (popup?.kind === "view") {
          this.host.destroy(popup.id);
          return this.popupExited(popup.id);
        }
        if (popup?.kind === "ask") {
          popup.hidden = true;
          return;
        }
        const hidden = this.hiddenAsks().at(-1);
        if (hidden) {
          hidden.hidden = false;
          this.shownPopups.add(hidden.id);
          return;
        }
        const last = this.lastJobs.get(this.tab.id);
        if (last !== undefined && this.jobStatus(last)?.tabId === this.tab.id) return this.openJob(last);
        const newest = this.jobs.filter((job) => job.tabId === this.tab.id).reduce<Job | undefined>((found, job) => (found && found.started > job.started ? found : job), undefined);
        if (newest) return this.openJob(newest.id);
        this.message = "No job or question to reopen";
        return;
      }
      case "toggle-drawer":
        return this.toggleDrawer();
      case "resize-drawer": {
        const drawer = this.drawerOf();
        if (!drawer) return;
        drawer.zoomed = false;
        drawer.height = Math.min(Math.max(drawer.height + command.delta * drawerHeights.step, drawerHeights.min), drawerHeights.max);
        return;
      }
      case "compose-claude":
        this.message = this.host.composeClaude(this.focused, this.tabPanes(this.tab));
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
      case "start-layout-jobs":
        return this.startLayoutJobs();
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

  private moveFocus(direction: Direction): void {
    const tab = this.tab;
    if (this.drawerOf(tab)) {
      if (direction === "up") this.leaveDrawer(tab);
      return;
    }
    const target = neighbor(tab.root, tab.layoutFocus, direction);
    if (target !== undefined) Object.assign(tab, { layoutFocus: target, zoomed: false });
  }

  private toggleDrawer(): void {
    const tab = this.tab;
    if (this.drawerOf(tab)) return this.leaveDrawer(tab);
    if (!tab.drawer) {
      const id = this.nextPaneId++;
      const spec = tab.drawerSpec ?? {};
      tab.drawer = { id, height: spec.height ?? drawerHeights.initial, open: false, zoomed: false };
      if (spec.name) this.paneNames.set(id, spec.name);
      this.host.create(id, this.host.cwd(tab.layoutFocus) ?? tab.cwd, spec.command, tab.id);
    }
    this.showDrawer(tab);
  }

  private showDrawer(tab: Tab): void {
    if (tab.drawer) tab.drawer.open = true;
  }

  private leaveDrawer(tab: Tab): void {
    if (!tab.drawer?.open) return;
    tab.drawer.open = false;
    if (this.mode === "resize" && tab === this.tab) this.mode = "normal";
  }

  private forgetDrawer(tab: Tab): void {
    this.forgetPane(tab.drawer!.id);
    tab.drawer = undefined;
    if (this.mode === "resize" && tab === this.tab) this.mode = "normal";
  }

  private forgetPane(id: PaneId): void {
    this.paneNames.delete(id);
    this.agents.delete(id);
    this.replies.delete(id);
    this.commands.delete(id);
    this.activities.delete(id);
    this.modes.delete(id);
    this.dormant.delete(id);
  }

  private newPane(axis: Axis | undefined): void {
    this.addPane((_root, _focused, id) => this.placeNew(this.tab, id, axis));
  }

  private placeNew(tab: Tab, id: PaneId, axis: Axis | undefined): LayoutNode {
    const { root, layoutFocus } = tab;
    const grouped = axis === undefined ? (inPaneTabs(root, layoutFocus) ? addPaneTab(root, layoutFocus, id) : addToFirstTabs(root, id)) : undefined;
    return grouped ?? splitPane(root, layoutFocus, axis ?? this.preferredAxis(tab), id);
  }

  private addPane(place: (root: LayoutNode, focused: PaneId, id: PaneId) => LayoutNode): void {
    const tab = this.tab;
    const id = this.nextPaneId++;
    tab.root = place(tab.root, tab.layoutFocus, id);
    const cwd = this.host.cwd(this.focused);
    tab.layoutFocus = id;
    tab.zoomed = false;
    this.leaveDrawer(tab);
    this.host.create(id, cwd, undefined, tab.id);
  }

  private preferredAxis(tab: Tab): Axis {
    const rect = paneRects(tab.root).get(tab.layoutFocus)!;
    const { cols, rows } = this.host.screen();
    return rect.width * cols > rect.height * rows * 2.2 ? "row" : "column";
  }

  private openTab(cwd: string | undefined, options: { name?: string; layout?: LayoutEntry; withJobs?: boolean } = {}): void {
    const number = this.nextTabNumber++;
    const layout = options.layout?.layout ?? {};
    const tab: Tab = { id: number, name: options.name ?? `Tab #${number}`, root: leaf(0), layoutFocus: 0, zoomed: false, layout, layoutJobs: options.layout?.jobs ?? [], layoutRuns: new Map(), cwd, drawerSpec: options.layout?.drawer };
    this.tabs.splice(this.tabs.length === 0 ? 0 : this.active + 1, 0, tab);
    this.active = this.tabs.length === 1 ? 0 : this.active + 1;
    this.createLayoutPanes(tab);
    if (options.withJobs ?? true) tab.layoutJobs.forEach((_, index) => this.runLayoutJob(tab, index));
  }

  private createLayoutPanes(tab: Tab): void {
    const plan = planLayout(tab.layout, () => this.nextPaneId++);
    Object.assign(tab, { root: plan.root, layoutFocus: plan.focus, zoomed: false });
    for (const pane of plan.panes) {
      if (pane.name) this.paneNames.set(pane.id, pane.name);
      this.host.create(pane.id, tab.cwd, pane.command, tab.id);
    }
  }

  private restartTab(): void {
    const tab = this.tab;
    const withJobs = tab.layoutRuns.size > 0;
    for (const job of this.tabJobs(tab)) this.closeJob(job.id);
    for (const popup of this.popups.filter((popup) => popup.tabId === tab.id)) {
      this.host.destroy(popup.id);
      this.popupExited(popup.id);
    }
    this.destroyTabPanes(tab);
    tab.layoutRuns = new Map();
    this.createLayoutPanes(tab);
    if (withJobs) tab.layoutJobs.forEach((_, index) => this.runLayoutJob(tab, index));
  }

  private runLayoutJob(tab: Tab, index: number): void {
    const spec = tab.layoutJobs[index]!;
    const id = this.runJob(tab.layoutFocus, spec.command, spec.name, { cwd: tab.cwd, dock: spec.dock });
    const started = id === undefined ? undefined : this.jobStatus(id);
    if (!started) return;
    started.layout = true;
    tab.layoutRuns.set(index, started.id);
  }

  private startLayoutJobs(): void {
    const tab = this.tab;
    if (tab.layoutJobs.length === 0) {
      this.message = "This tab's layout has no jobs";
      return;
    }
    let started = 0;
    tab.layoutJobs.forEach((_, index) => {
      const id = tab.layoutRuns.get(index);
      const job = id === undefined ? undefined : this.jobStatus(id);
      if (job?.state === "running" || (id !== undefined && !job && paneIds(tab.root).includes(id))) return;
      started++;
      if (job) this.rerunJob(job);
      else this.runLayoutJob(tab, index);
    });
    if (started === 0) this.message = "All of this tab's layout jobs are running";
  }

  private moveTab(delta: number): void {
    const target = this.active + delta;
    if (target < 0 || target >= this.tabs.length) return;
    const [tab] = this.tabs.splice(this.active, 1);
    this.tabs.splice(target, 0, tab!);
    this.active = target;
  }

  private removeTab(index: number): void {
    const tab = this.tabs[index]!;
    for (const job of this.tabJobs(tab)) this.closeJob(job.id);
    if (tab.drawer) {
      this.host.destroy(tab.drawer.id);
      this.forgetDrawer(tab);
    }
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
    this.destroyTabPanes(this.tab);
    this.removeTab(index);
  }

  private destroyTabPanes(tab: Tab): void {
    for (const id of paneIds(tab.root)) {
      this.host.destroy(id);
      this.forgetPane(id);
    }
  }

  private editPrompt(key: InputKey): void {
    const prompt = this.prompt!;
    if (key.name === "escape") {
      this.prompt = undefined;
      return;
    }
    if (key.name === "return") {
      this.prompt = undefined;
      return this.commitPrompt(prompt, !key.meta);
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

  private commitPrompt(prompt: Prompt, withJobs: boolean): void {
    const text = prompt.text.trim();
    switch (prompt.kind) {
      case "rename-tab":
        if (text) this.tab.name = text;
        return;
      case "rename-pane":
        if (text) this.paneNames.set(this.focused, text);
        else this.paneNames.delete(this.focused);
        return;
      case "run-job":
        if (text) this.runJob(this.focused, this.host.shellCommand(text), text);
        return;
      case "close-tab":
        if (prompt.text === this.tab.name) return this.closeTab();
        this.message = "Kept the tab";
        return;
      case "restart-tab":
        if (prompt.text === this.tab.name) return this.restartTab();
        this.message = "Left the tab running";
        return;
      case "open-project": {
        if (prompt.marked && prompt.marked.length > 0) return this.openProjects(prompt.marked, withJobs);
        const target = looksLikePath(text) ? text : (prompt.matches?.[prompt.selected]?.name ?? text);
        if (target) this.message = this.openProject(target, withJobs);
        return;
      }
    }
  }
}

function focusedPane(tab: Tab): PaneId {
  return tab.drawer?.open ? tab.drawer.id : tab.layoutFocus;
}

function ownPanes(tab: Tab): PaneId[] {
  return [...paneIds(tab.root), ...(tab.drawer ? [tab.drawer.id] : [])];
}

function focusedPaneOf(tab: Tab | undefined): PaneId | undefined {
  return tab && focusedPane(tab);
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
