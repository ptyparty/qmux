import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type StyledText } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { hints, modeHints, type Hint, type Mode } from "./keymap.ts";
import { JobsPanel, jobBadge, jobDetail } from "./jobs-panel.ts";
import { Launcher } from "./launcher.ts";
import { paneIds, shownPaneTab, type LayoutNode, type PaneId, type TabsNode } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { theme } from "./theme.ts";
import type { Tray } from "./tray.ts";
import type { AgentState, CommandState, Workspace } from "./workspace.ts";

export class MuxView {
  private readonly tabBar: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly modeBar: TextRenderable;
  private readonly trayBar: TextRenderable;
  private trayRanges: { start: number; end: number; index: number }[] = [];
  private readonly hintBar: TextRenderable;
  private readonly overlay: BoxRenderable;
  private bodySignature = "";
  private paneTabStrips: { strip: TextRenderable; group: TabsNode; ranges: { start: number; end: number; id: PaneId }[] }[] = [];
  private readonly launcher: Launcher;
  private readonly jobsPanel: JobsPanel;
  private readonly toastBox: BoxRenderable;
  private readonly toastText: TextRenderable;
  private toastTargets: PaneId[] = [];
  private readonly dock: TextRenderable;
  private dockJobs: PaneId[] = [];
  private overlayPane: PaneId | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly workspace: Workspace,
    private readonly panes: Map<PaneId, Pane>,
    private readonly tray: Tray,
    private readonly actions: { onFocusPane: (id: PaneId) => void; onOpenWidget: (index: number) => void; onOpenJob: (id: PaneId) => void; jobLine: (id: PaneId) => string | undefined },
  ) {
    const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background });
    this.tabBar = new TextRenderable(renderer, { height: 1, bg: theme.surface });
    this.body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", minHeight: 0 });
    const statusRow = new BoxRenderable(renderer, { height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: theme.surface });
    this.modeBar = new TextRenderable(renderer, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, wrapMode: "none", bg: theme.surface });
    this.trayBar = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", bg: theme.surface });
    this.trayBar.onMouseDown = (event) => {
      const offset = event.x - this.trayBar.screenX;
      const hit = this.trayRanges.find((range) => offset >= range.start && offset < range.end);
      if (hit) this.actions.onOpenWidget(hit.index);
    };
    statusRow.add(this.modeBar);
    statusRow.add(this.trayBar);
    this.hintBar = new TextRenderable(renderer, { height: 1, fg: theme.muted });
    this.dock = new TextRenderable(renderer, { flexShrink: 0, wrapMode: "none", visible: false });
    this.dock.onMouseDown = (event) => {
      const id = this.dockJobs[event.y - this.dock.screenY];
      if (id !== undefined) this.actions.onOpenJob(id);
    };
    root.add(this.tabBar);
    root.add(this.body);
    root.add(this.dock);
    root.add(statusRow);
    root.add(this.hintBar);
    this.overlay = new BoxRenderable(renderer, {
      position: "absolute",
      left: "10%",
      top: "10%",
      width: "80%",
      height: "80%",
      zIndex: 100,
      visible: false,
    });
    renderer.root.add(root);
    renderer.root.add(this.overlay);
    this.toastBox = new BoxRenderable(renderer, {
      position: "absolute",
      right: 1,
      bottom: toastBottom,
      zIndex: 150,
      visible: false,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.surface,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.toastText = new TextRenderable(renderer, { wrapMode: "none" });
    this.toastText.onMouseDown = (event) => {
      const id = this.toastTargets[event.y - this.toastText.screenY];
      if (id === undefined) return;
      if (this.workspace.jobStatus(id)) this.actions.onOpenJob(id);
      else this.actions.onFocusPane(id);
    };
    this.toastBox.add(this.toastText);
    renderer.root.add(this.toastBox);
    this.launcher = new Launcher(renderer);
    this.jobsPanel = new JobsPanel(renderer);
  }

  render(): void {
    const tab = this.workspace.tab;
    this.renderBody(tab.root, tab.zoomed ? tab.focused : undefined);
    const popup = this.renderOverlay();
    for (const id of paneIds(tab.root)) {
      const pane = this.panes.get(id);
      if (!pane) continue;
      pane.show(this.paneTitle(id, pane), id === tab.focused && this.workspace.prompt === undefined && !popup, modeFocusColor(this.workspace.mode));
    }
    this.renderPaneTabStrips();
    this.tabBar.content = this.renderTabs();
    this.modeBar.content = this.renderModes();
    this.trayBar.content = this.renderTray();
    this.hintBar.content = this.renderHints();
    this.launcher.render(this.workspace.prompt);
    const showJobs = this.workspace.mode === "jobs" && !this.workspace.prompt;
    this.jobsPanel.render(showJobs ? this.workspace.tabJobs() : undefined, this.workspace.selectedJob, Date.now());
    this.renderToasts();
    this.renderDock();
  }

  private renderDock(): void {
    const jobs = this.workspace.tabJobs().filter((job) => job.dock);
    this.dock.visible = jobs.length > 0;
    this.dockJobs = jobs.map((job) => job.id);
    this.toastBox.bottom = toastBottom + jobs.length;
    if (jobs.length === 0) return;
    this.dock.height = jobs.length;
    const nameWidth = Math.min(Math.max(...jobs.map((job) => Bun.stringWidth(job.name))), 24);
    const room = Math.max(this.renderer.width - nameWidth - 8, 10);
    const rows = jobs.map((job) => {
      const name = fit(job.name, nameWidth, true);
      const state = this.workspace.agents.get(job.id);
      if (job.agent) {
        const reply = this.workspace.replies.get(job.id);
        const text = reply ? firstLine(reply.text, room) : fit(state ? agentLabels[state] : "ready", room);
        const color = state ? agentColors[state] : theme.muted;
        return [bold(fg(color)(` ${state ? agentBadges[state] : "🧠"} ${name}`)), fg(theme.muted)(" │ "), fg(theme.text)(text)];
      }
      const line = this.actions.jobLine(job.id) || (job.state === "running" ? "no output yet" : jobDetail(job, Date.now()));
      const shown = fit(line, room);
      const color = job.state === "running" ? theme.text : commandColors[job.state];
      return [bold(fg(color)(` ${jobBadge(job)} ${name}`)), fg(theme.muted)(" │ "), fg(theme.muted)(shown)];
    });
    this.dock.content = styled(rows.flatMap((row, index) => [...(index > 0 ? ["\n"] : []), ...row]));
  }

  private renderToasts(): void {
    const toasts = this.workspace.toasts();
    this.toastBox.visible = toasts.length > 0;
    this.toastTargets = toasts.map((toast) => (toast.kind === "job" ? toast.job.id : toast.id));
    if (toasts.length === 0) return;
    const lines = toasts.map((toast) => {
      const where = toast.tab === this.workspace.tab ? "" : ` · ${toast.tab.name}`;
      if (toast.kind === "reply") {
        const name = this.workspace.paneNames.get(toast.id) ?? "Claude";
        return { text: `💬 ${name}${where} · ${firstLine(toast.reply.text, 60)} · Alt p`, color: theme.accent };
      }
      const { job } = toast;
      const open = job.state === "failed" ? " · Alt a" : "";
      return { text: `${jobBadge(job)} ${job.name} · ${jobDetail(job, Date.now())}${where}${open}`, color: job.state === "failed" ? commandColors.failed : commandColors.succeeded };
    });
    this.toastText.content = styled(lines.flatMap((line, index) => [...(index > 0 ? ["\n"] : []), fg(line.color)(line.text)]));
    this.toastBox.width = Math.min(Math.max(...lines.map((line) => Bun.stringWidth(line.text))) + 4, Math.floor(this.renderer.width * 0.6));
    this.toastBox.height = lines.length + 2;
  }

  private renderBody(root: LayoutNode, zoomed: PaneId | undefined): void {
    const signature = JSON.stringify([this.workspace.active, this.workspace.tab.id, this.workspace.tab.focused, zoomed, root]);
    if (signature === this.bodySignature) return;
    this.bodySignature = signature;
    for (const tab of this.workspace.tabs) {
      for (const id of paneIds(tab.root)) {
        const frame = this.panes.get(id)?.frame;
        frame?.parent?.remove(frame);
      }
    }
    for (const child of this.body.getChildren()) child.destroyRecursively();
    this.paneTabStrips = [];
    const zoomedPane = zoomed === undefined ? undefined : this.panes.get(zoomed);
    if (zoomedPane) this.body.add(this.slot(zoomedPane.frame));
    else this.body.add(this.build(root));
  }

  private renderOverlay(): boolean {
    const popup = this.workspace.popup;
    const pane = popup && this.panes.get(popup.id);
    if (this.overlayPane !== popup?.id) {
      const previous = this.overlayPane === undefined ? undefined : this.panes.get(this.overlayPane);
      if (previous) this.overlay.remove(previous.frame);
      if (pane) this.overlay.add(pane.frame);
      this.overlayPane = pane ? popup.id : undefined;
    }
    this.overlay.visible = pane !== undefined;
    if (!pane) return false;
    const { width, height } = popup.size ?? defaultPopupSize;
    this.overlay.width = `${width}%`;
    this.overlay.height = `${height}%`;
    this.overlay.left = `${(100 - width) / 2}%`;
    this.overlay.top = `${(100 - height) / 2}%`;
    const waiting = this.workspace.popupsWaiting(this.workspace.tab) - (popup.kind === "ask" ? 1 : 0);
    const job = popup.kind === "job" ? this.workspace.jobStatus(popup.id) : undefined;
    const title = job ? `${jobBadge(job)} ${job.name} · ${jobDetail(job, Date.now())}` : popup.title;
    pane.show(waiting > 0 ? `${title} (+${waiting} waiting)` : title, this.workspace.prompt === undefined);
    return true;
  }

  private build(node: LayoutNode): BoxRenderable {
    if (node.kind === "pane") {
      const pane = this.panes.get(node.id);
      return pane ? this.slot(pane.frame) : new BoxRenderable(this.renderer, { flexGrow: 1, flexBasis: 0 });
    }
    if (node.kind === "tabs") return this.buildTabs(node);
    const container = new BoxRenderable(this.renderer, { flexDirection: node.axis, flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 });
    for (const child of node.children) container.add(this.build(child));
    return container;
  }

  private buildTabs(group: TabsNode): BoxRenderable {
    const container = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 });
    const strip = new TextRenderable(this.renderer, { height: 1, flexShrink: 0, bg: theme.surface, wrapMode: "none" });
    const entry = { strip, group, ranges: [] as { start: number; end: number; id: PaneId }[] };
    strip.onMouseDown = (event) => {
      const offset = event.x - strip.screenX;
      const hit = entry.ranges.find((range) => offset >= range.start && offset < range.end);
      if (hit) this.actions.onFocusPane(hit.id);
    };
    this.paneTabStrips.push(entry);
    container.add(strip);
    const shown = this.panes.get(group.panes[shownPaneTab(group, this.workspace.tab.focused)]!);
    if (shown) container.add(this.slot(shown.frame));
    return container;
  }

  private renderPaneTabStrips(): void {
    const focused = this.workspace.tab.focused;
    for (const entry of this.paneTabStrips) {
      const selected = shownPaneTab(entry.group, focused);
      const groupFocused = entry.group.panes.includes(focused) && !this.workspace.prompt && !this.workspace.popup;
      const parts: Part[] = [" "];
      let column = 1;
      entry.ranges = [];
      entry.group.panes.forEach((id, index) => {
        const pane = this.panes.get(id);
        if (!pane) return;
        if (index > 0) {
          parts.push(fg(theme.border)("│"));
          column += 1;
        }
        const state = this.workspace.agents.get(id);
        const command = this.workspace.commands.get(id);
        const badges = `${state ? `${agentBadges[state]} ` : ""}${command ? `${commandBadges[command]} ` : ""}`;
        const label = ` ${badges}${pane.label(this.workspace.paneNames.get(id))} `;
        const color = groupFocused ? modeFocusColor(this.workspace.mode) : theme.border;
        if (index === selected) parts.push(bold(bg(color)(fg(groupFocused ? theme.background : theme.text)(label))));
        else parts.push(fg(state ? agentColors[state] : command ? commandColors[command] : theme.muted)(label));
        entry.ranges.push({ start: column, end: column + label.length, id });
        column += label.length;
      });
      entry.strip.content = styled(parts);
    }
  }

  private slot(frame: BoxRenderable): BoxRenderable {
    const slot = new BoxRenderable(this.renderer, { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 });
    slot.add(frame);
    return slot;
  }

  private paneTitle(id: PaneId, pane: Pane): string {
    const zoomed = this.workspace.tab.zoomed && id === this.workspace.tab.focused ? " (zoomed)" : "";
    const state = this.workspace.agents.get(id);
    const command = this.workspace.commands.get(id);
    const badge = state ? `${agentBadges[state]} ${agentLabels[state]} · ` : "";
    const commandBadge = command ? `${commandBadges[command]} ${commandLabels[command]} · ` : "";
    return `${badge}${commandBadge}${pane.label(this.workspace.paneNames.get(id))}${zoomed}`;
  }

  private renderTabs(): StyledText {
    const focusColor = modeFocusColor(this.workspace.mode);
    const parts: Part[] = [bold(fg(theme.accent)(" qmux "))];
    this.workspace.tabs.forEach((tab, index) => {
      const active = index === this.workspace.active;
      const asking = this.workspace.popupsWaiting(tab) > 0 ? " ?" : "";
      const attention = this.workspace.tabAttention(tab);
      const paint = (text: string, color: string) => (active ? bold(bg(focusColor)(fg(theme.background)(text))) : fg(color)(text));
      parts.push(paint(` ${index + 1} ${tab.name}${asking}`, theme.muted));
      const command = this.workspace.tabCommandState(tab);
      if (attention) parts.push(paint(` ${agentBadges[attention]}`, agentColors[attention]));
      if (this.workspace.tabUnread(tab)) parts.push(paint(" 💬", theme.accent));
      if (command) parts.push(paint(` ${commandBadges[command]}`, commandColors[command]));
      parts.push(paint(" ", theme.muted), " ");
    });
    if (this.workspace.clients > 1) parts.push(fg(theme.warning)(` ${this.workspace.clients} terminals attached `));
    return styled(parts);
  }

  private renderModes(): StyledText {
    const mode = this.workspace.mode;
    const parts: Part[] = [bold(bg(theme.modes[mode])(fg(theme.background)(` ${mode.toUpperCase()} `))), " "];
    if (mode === "locked") parts.push(fg(theme.muted)("all keys go to the pane"));
    else {
      for (const hint of modeHints()) {
        const active = hint.mode === mode;
        parts.push(bold(fg(active ? theme.modes[hint.mode] : theme.accent)(hint.keys)), fg(active ? theme.text : theme.muted)(` ${hint.description}  `));
      }
    }
    return styled(parts);
  }

  private renderTray(): StyledText {
    const selecting = this.workspace.mode === "tray";
    const parts: Part[] = [];
    let column = 0;
    this.trayRanges = [];
    this.tray.texts.forEach((text, index) => {
      if (text === "") return;
      if (parts.length > 0) {
        parts.push(fg(theme.border)("│"));
        column += 1;
      }
      const label = ` ${text} `;
      const selected = selecting && index === this.workspace.selectedWidget;
      parts.push(selected ? bold(bg(theme.modes.tray)(fg(theme.background)(label))) : fg(theme.text)(label));
      this.trayRanges.push({ start: column, end: column + label.length, index });
      column += label.length;
    });
    return styled(parts);
  }

  private renderHints(): StyledText {
    const { prompt, message, mode } = this.workspace;
    if (prompt) return styled(hintParts(mode, [{ keys: "Enter", description: "confirm" }, { keys: "Esc", description: "cancel" }]));
    if (message) return styled([" ", fg(theme.warning)(message)]);
    if (this.workspace.popupWaitMs() !== undefined) {
      return styled([" ", fg(theme.warning)("A question is waiting"), fg(theme.muted)(" · it opens when you pause typing · "), bold(fg(theme.accent)("Alt a")), fg(theme.muted)(" open now")]);
    }
    if ((mode === "normal" || mode === "locked") && this.workspace.focusedPaneHeld()) {
      return styled([" ", fg(theme.warning)("Command exited"), fg(theme.border)("  ·  "), ...hintParts(mode, heldHints).slice(1)]);
    }
    return styled(hintParts(mode));
  }
}

function modeFocusColor(mode: Mode): string {
  return mode === "normal" ? theme.accent : theme.modes[mode];
}

const toastBottom = 3;
const defaultPopupSize = { width: 80, height: 80 };
const agentBadges: Record<AgentState, string> = { working: "🧠", waiting: "!", done: "🚀", failed: "✗" };
const agentLabels: Record<AgentState, string> = { working: "working", waiting: "needs you", done: "done", failed: "failed" };
const agentColors: Record<AgentState, string> = { working: theme.accent, waiting: theme.warning, done: theme.modes.normal, failed: theme.modes.locked };
const commandBadges: Record<CommandState, string> = { running: "⏳", succeeded: "🎉", failed: "💥" };
const commandLabels: Record<CommandState, string> = { running: "running", succeeded: "succeeded", failed: "failed" };
const commandColors: Record<CommandState, string> = { running: theme.accent, succeeded: theme.modes.normal, failed: theme.modes.locked };

const heldHints: Hint[] = [
  { keys: "Enter", description: "re-run" },
  { keys: "Esc", description: "shell" },
  { keys: "^c", description: "close" },
];

function hintParts(mode: Mode, list: Hint[] = hints(mode)): Part[] {
  const parts: Part[] = [" "];
  list.forEach((hint, index) => {
    if (index > 0) parts.push(fg(theme.border)("  ·  "));
    parts.push(bold(fg(theme.accent)(hint.keys)), fg(theme.muted)(` ${hint.description}`));
  });
  return parts;
}

function firstLine(text: string, max: number): string {
  return fit(text.split("\n").find((candidate) => candidate.trim())?.replace(/[*_`#>]/g, "").trim() ?? "", max);
}

function fit(text: string, width: number, pad = false): string {
  if (Bun.stringWidth(text) <= width) return pad ? text + " ".repeat(width - Bun.stringWidth(text)) : text;
  let cut = "";
  for (const char of text) {
    if (Bun.stringWidth(cut + char) > width - 1) break;
    cut += char;
  }
  return `${cut}…${pad ? " ".repeat(Math.max(width - 1 - Bun.stringWidth(cut), 0)) : ""}`;
}
