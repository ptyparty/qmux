import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type StyledText } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { hints, modeHints, type Hint, type Mode } from "./keymap.ts";
import { Launcher } from "./launcher.ts";
import { paneIds, shownMember, type LayoutNode, type PaneId, type StackNode } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { theme } from "./theme.ts";
import type { AgentState, Workspace } from "./workspace.ts";

export class MuxView {
  private readonly tabBar: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly modeBar: TextRenderable;
  private readonly hintBar: TextRenderable;
  private readonly overlay: BoxRenderable;
  private bodySignature = "";
  private readonly stackTitles = new Map<PaneId, TextRenderable>();
  private readonly launcher: Launcher;
  private overlayPane: PaneId | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly workspace: Workspace,
    private readonly panes: Map<PaneId, Pane>,
    private readonly onFocusPane: (id: PaneId) => void,
  ) {
    const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background });
    this.tabBar = new TextRenderable(renderer, { height: 1, bg: theme.surface });
    this.body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", minHeight: 0 });
    this.modeBar = new TextRenderable(renderer, { height: 1, bg: theme.surface });
    this.hintBar = new TextRenderable(renderer, { height: 1, fg: theme.muted });
    root.add(this.tabBar);
    root.add(this.body);
    root.add(this.modeBar);
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
    this.launcher = new Launcher(renderer);
  }

  render(): void {
    const tab = this.workspace.tab;
    this.renderBody(tab.root, tab.zoomed ? tab.focused : undefined);
    const popup = this.renderOverlay();
    for (const id of paneIds(tab.root)) {
      const pane = this.panes.get(id);
      if (!pane) continue;
      const title = this.stackTitles.get(id);
      if (title) title.content = styled([fg(theme.muted)(` ▸ ${this.paneTitle(id, pane)}`)]);
      const mode = this.workspace.mode;
      pane.show(this.paneTitle(id, pane), id === tab.focused && this.workspace.prompt === undefined && !popup, mode === "normal" ? theme.accent : theme.modes[mode]);
    }
    this.tabBar.content = this.renderTabs();
    this.modeBar.content = this.renderModes();
    this.hintBar.content = this.renderHints();
    this.launcher.render(this.workspace.prompt);
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
    this.stackTitles.clear();
    const zoomedPane = zoomed === undefined ? undefined : this.panes.get(zoomed);
    if (zoomedPane) this.body.add(this.slot(zoomedPane.frame, 1));
    else this.body.add(this.build(root, 1));
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
    const waiting = this.workspace.popupsWaiting(this.workspace.tab) - 1;
    pane.show(waiting > 0 ? `${popup.title} (+${waiting} waiting)` : popup.title, true);
    return true;
  }

  private build(node: LayoutNode, weight: number): BoxRenderable {
    if (node.kind === "pane") {
      const pane = this.panes.get(node.id);
      return pane ? this.slot(pane.frame, weight) : new BoxRenderable(this.renderer, { flexGrow: weight, flexBasis: 0 });
    }
    if (node.kind === "stack") return this.buildStack(node, weight);
    const container = new BoxRenderable(this.renderer, {
      flexDirection: node.axis,
      flexGrow: weight,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
    });
    for (const child of node.children) container.add(this.build(child.node, child.weight));
    return container;
  }

  private buildStack(stack: StackNode, weight: number): BoxRenderable {
    const container = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: weight, flexBasis: 0, minWidth: 0, minHeight: 0 });
    const shown = shownMember(stack, this.workspace.tab.focused);
    stack.panes.forEach((id, index) => {
      const pane = this.panes.get(id);
      if (!pane) return;
      if (index === shown) {
        container.add(this.slot(pane.frame, 1));
        return;
      }
      const title = new TextRenderable(this.renderer, { height: 1, bg: theme.surface, onMouseDown: () => this.onFocusPane(id) });
      this.stackTitles.set(id, title);
      container.add(title);
    });
    return container;
  }

  private slot(frame: BoxRenderable, weight: number): BoxRenderable {
    const slot = new BoxRenderable(this.renderer, { flexGrow: weight, flexBasis: 0, minWidth: 0, minHeight: 0 });
    slot.add(frame);
    return slot;
  }

  private paneTitle(id: PaneId, pane: Pane): string {
    const zoomed = this.workspace.tab.zoomed && id === this.workspace.tab.focused ? " (zoomed)" : "";
    const state = this.workspace.agents.get(id);
    const badge = state ? `${agentBadges[state]} ${agentLabels[state]} · ` : "";
    return `${badge}${pane.label(this.workspace.paneNames.get(id))}${zoomed}`;
  }

  private renderTabs(): StyledText {
    const parts: Part[] = [bold(fg(theme.accent)(" qmux "))];
    this.workspace.tabs.forEach((tab, index) => {
      const active = index === this.workspace.active;
      const asking = this.workspace.popupsWaiting(tab) > 0 ? " ?" : "";
      const attention = this.workspace.tabAttention(tab);
      const paint = (text: string, color: string) => (active ? bold(bg(theme.accent)(fg(theme.background)(text))) : fg(color)(text));
      parts.push(paint(` ${index + 1} ${tab.name}${asking}`, theme.muted));
      if (attention) parts.push(paint(` ${agentBadges[attention]}`, agentColors[attention]));
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

  private renderHints(): StyledText {
    const { prompt, message, mode } = this.workspace;
    if (prompt) return styled(hintParts(mode, [{ keys: "Enter", description: "confirm" }, { keys: "Esc", description: "cancel" }]));
    if (message) return styled([" ", fg(theme.warning)(message)]);
    if ((mode === "normal" || mode === "locked") && this.workspace.focusedPaneHeld()) {
      return styled([" ", fg(theme.warning)("Command exited"), fg(theme.border)("  ·  "), ...hintParts(mode, heldHints).slice(1)]);
    }
    return styled(hintParts(mode));
  }
}

const agentBadges: Record<AgentState, string> = { working: "●", waiting: "!", done: "✓" };
const agentLabels: Record<AgentState, string> = { working: "working", waiting: "needs you", done: "done" };
const agentColors: Record<AgentState, string> = { working: theme.accent, waiting: theme.warning, done: theme.modes.normal };

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
