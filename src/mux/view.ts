import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type StyledText } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { hints, modeHints, type Mode } from "./keymap.ts";
import { paneIds, type LayoutNode, type PaneId } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { theme } from "./theme.ts";
import type { Workspace } from "./workspace.ts";

export class MuxView {
  private readonly tabBar: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly modeBar: TextRenderable;
  private readonly hintBar: TextRenderable;
  private readonly overlay: BoxRenderable;
  private bodySignature = "";
  private overlayPane: PaneId | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly workspace: Workspace,
    private readonly panes: Map<PaneId, Pane>,
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
  }

  render(): void {
    const tab = this.workspace.tab;
    this.renderBody(tab.root, tab.zoomed ? tab.focused : undefined);
    const popup = this.renderOverlay();
    for (const id of paneIds(tab.root)) {
      const pane = this.panes.get(id);
      pane?.show(this.paneTitle(id, pane), id === tab.focused && this.workspace.prompt === undefined && !popup);
    }
    this.tabBar.content = this.renderTabs();
    this.modeBar.content = this.renderModes();
    this.hintBar.content = this.renderHints();
  }

  private renderBody(root: LayoutNode, zoomed: PaneId | undefined): void {
    const signature = JSON.stringify([this.workspace.active, this.workspace.tab.id, zoomed, root]);
    if (signature === this.bodySignature) return;
    this.bodySignature = signature;
    for (const tab of this.workspace.tabs) {
      for (const id of paneIds(tab.root)) {
        const frame = this.panes.get(id)?.frame;
        frame?.parent?.remove(frame);
      }
    }
    for (const child of this.body.getChildren()) child.destroyRecursively();
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
    const waiting = this.workspace.popups.length - 1;
    pane.show(waiting > 0 ? `${popup.title} (+${waiting} waiting)` : popup.title, true);
    return true;
  }

  private build(node: LayoutNode, weight: number): BoxRenderable {
    if (node.kind === "pane") {
      const pane = this.panes.get(node.id);
      return pane ? this.slot(pane.frame, weight) : new BoxRenderable(this.renderer, { flexGrow: weight, flexBasis: 0 });
    }
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

  private slot(frame: BoxRenderable, weight: number): BoxRenderable {
    const slot = new BoxRenderable(this.renderer, { flexGrow: weight, flexBasis: 0, minWidth: 0, minHeight: 0 });
    slot.add(frame);
    return slot;
  }

  private paneTitle(id: PaneId, pane: Pane): string {
    const zoomed = this.workspace.tab.zoomed && id === this.workspace.tab.focused ? " (zoomed)" : "";
    return `${pane.label(this.workspace.paneNames.get(id))}${zoomed}`;
  }

  private renderTabs(): StyledText {
    const parts: Part[] = [bold(fg(theme.accent)(" qmux "))];
    this.workspace.tabs.forEach((tab, index) => {
      const label = ` ${index + 1} ${tab.name} `;
      parts.push(index === this.workspace.active ? bold(bg(theme.accent)(fg(theme.background)(label))) : fg(theme.muted)(label), " ");
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
    if (prompt) {
      const parts: Part[] = [" ", bold(fg(theme.warning)(prompt.label)), ": ", fg(theme.text)(prompt.text), bg(theme.text)(" ")];
      if (prompt.matches) {
        parts.push("  ");
        prompt.matches.forEach((match, index) => parts.push(index === 0 ? bold(fg(theme.accent)(match.name)) : fg(theme.muted)(match.name), "  "));
        parts.push(fg(theme.muted)(prompt.matches.length ? "· Tab complete · Enter open · Esc cancel" : "no matches · Esc cancel"));
      } else {
        parts.push(fg(theme.muted)("   Enter confirm · Esc cancel"));
      }
      return styled(parts);
    }
    if (message) return styled([" ", fg(theme.warning)(message)]);
    return styled(hintParts(mode));
  }
}

function hintParts(mode: Mode): Part[] {
  const parts: Part[] = [" "];
  hints(mode).forEach((hint, index) => {
    if (index > 0) parts.push(fg(theme.border)("  ·  "));
    parts.push(bold(fg(theme.accent)(hint.keys)), fg(theme.muted)(` ${hint.description}`));
  });
  return parts;
}
