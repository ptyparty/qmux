export type PaneId = number;
export type Axis = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";

export type LayoutNode =
  | { kind: "pane"; id: PaneId }
  | { kind: "split"; axis: Axis; children: LayoutNode[] }
  | { kind: "tabs"; panes: PaneId[]; selected: number };

export type Rect = { x: number; y: number; width: number; height: number };

const epsilon = 1e-9;

export function leaf(id: PaneId): LayoutNode {
  return { kind: "pane", id };
}

export function splitPane(root: LayoutNode, target: PaneId, axis: Axis, added: PaneId): LayoutNode {
  return mapPaneParent(root, target, {
    inSplit: (split, index) => {
      if (split.axis !== axis) return undefined;
      const children = [...split.children];
      children.splice(index + 1, 0, leaf(added));
      return { ...split, children };
    },
    atPane: (pane) => ({ kind: "split", axis, children: [pane, leaf(added)] }),
  });
}

export function addPaneTab(root: LayoutNode, target: PaneId, added: PaneId): LayoutNode {
  return mapPaneParent(root, target, {
    inSplit: () => undefined,
    atPane: (node) => {
      if (node.kind === "pane") return { kind: "tabs", panes: [node.id, added], selected: 1 };
      const index = node.panes.indexOf(target) + 1;
      return { kind: "tabs", panes: [...node.panes.slice(0, index), added, ...node.panes.slice(index)], selected: index };
    },
  });
}

export function shownPaneTab(group: TabsNode, focused: PaneId | undefined): number {
  const index = focused === undefined ? -1 : group.panes.indexOf(focused);
  return index >= 0 ? index : group.selected;
}

export function addToFirstTabs(root: LayoutNode, added: PaneId): LayoutNode | undefined {
  const group = findTabs(root, () => true);
  if (!group) return undefined;
  return replaceNode(root, group, { kind: "tabs", panes: [...group.panes, added], selected: group.panes.length });
}

export function inPaneTabs(root: LayoutNode, target: PaneId): boolean {
  return findTabs(root, (candidate) => candidate.panes.includes(target)) !== undefined;
}

export function selectPaneTab(root: LayoutNode, target: PaneId): LayoutNode {
  const group = findTabs(root, (candidate) => candidate.panes.includes(target));
  if (!group || group.panes[group.selected] === target) return root;
  return replaceNode(root, group, { ...group, selected: group.panes.indexOf(target) });
}

export function paneTabSibling(root: LayoutNode, target: PaneId): PaneId | undefined {
  const group = findTabs(root, (candidate) => candidate.panes.includes(target));
  if (!group) return undefined;
  const index = group.panes.indexOf(target);
  return group.panes[index + 1] ?? group.panes[index - 1];
}

export function removePane(root: LayoutNode, target: PaneId): LayoutNode | null {
  if (root.kind === "pane") return root.id === target ? null : root;
  if (root.kind === "tabs") {
    const index = root.panes.indexOf(target);
    if (index < 0) return root;
    const panes = root.panes.filter((id) => id !== target);
    if (panes.length === 0) return null;
    if (panes.length === 1) return leaf(panes[0]!);
    const selected = index < root.selected ? root.selected - 1 : Math.min(root.selected, panes.length - 1);
    return { kind: "tabs", panes, selected };
  }
  const children = root.children.map((child) => removePane(child, target)).filter((child): child is LayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...root, children };
}

export function paneIds(root: LayoutNode): PaneId[] {
  switch (root.kind) {
    case "pane":
      return [root.id];
    case "tabs":
      return root.panes;
    case "split":
      return root.children.flatMap(paneIds);
  }
}

export function paneRects(root: LayoutNode, rect: Rect = { x: 0, y: 0, width: 1, height: 1 }): Map<PaneId, Rect> {
  if (root.kind === "pane") return new Map([[root.id, rect]]);
  if (root.kind === "tabs") return groupRects(root, rect);
  const rects = new Map<PaneId, Rect>();
  const share = 1 / root.children.length;
  root.children.forEach((child, index) => {
    const childRect =
      root.axis === "row"
        ? { x: rect.x + index * share * rect.width, y: rect.y, width: share * rect.width, height: rect.height }
        : { x: rect.x, y: rect.y + index * share * rect.height, width: rect.width, height: share * rect.height };
    for (const [id, paneRect] of paneRects(child, childRect)) rects.set(id, paneRect);
  });
  return rects;
}

export function neighbor(root: LayoutNode, from: PaneId, direction: Direction): PaneId | undefined {
  const rects = paneRects(root);
  const origin = rects.get(from);
  if (!origin) return undefined;
  let best: { id: PaneId; overlap: number; distance: number } | undefined;
  for (const [id, rect] of rects) {
    if (id === from || !touches(origin, rect, direction)) continue;
    const overlap = perpendicularOverlap(origin, rect, direction);
    if (overlap <= epsilon) continue;
    const distance = centerDistance(origin, rect);
    if (!best || overlap > best.overlap + epsilon || (Math.abs(overlap - best.overlap) <= epsilon && distance < best.distance)) {
      best = { id, overlap, distance };
    }
  }
  return best?.id;
}

function groupRects(group: TabsNode, rect: Rect): Map<PaneId, Rect> {
  return new Map([[group.panes[group.selected]!, rect]]);
}

function findTabs(root: LayoutNode, matches: (group: TabsNode) => boolean): TabsNode | undefined {
  if (root.kind === "tabs") return matches(root) ? root : undefined;
  if (root.kind === "pane") return undefined;
  for (const child of root.children) {
    const found = findTabs(child, matches);
    if (found) return found;
  }
  return undefined;
}

function holds(node: LayoutNode, target: PaneId): boolean {
  return (node.kind === "pane" && node.id === target) || (node.kind === "tabs" && node.panes.includes(target));
}

type SplitNode = Extract<LayoutNode, { kind: "split" }>;
type PaneNode = Extract<LayoutNode, { kind: "pane" }>;
export type TabsNode = Extract<LayoutNode, { kind: "tabs" }>;

function mapPaneParent(
  root: LayoutNode,
  target: PaneId,
  handlers: { inSplit: (split: SplitNode, index: number) => LayoutNode | undefined; atPane: (node: PaneNode | TabsNode) => LayoutNode },
): LayoutNode {
  if (root.kind !== "split") return holds(root, target) ? handlers.atPane(root) : root;
  const index = root.children.findIndex((child) => holds(child, target));
  if (index >= 0) {
    const replaced = handlers.inSplit(root, index);
    if (replaced) return replaced;
  }
  return { ...root, children: root.children.map((child) => mapPaneParent(child, target, handlers)) };
}

function replaceNode(root: LayoutNode, from: LayoutNode, to: LayoutNode): LayoutNode {
  if (root === from) return to;
  if (root.kind !== "split") return root;
  return { ...root, children: root.children.map((child) => replaceNode(child, from, to)) };
}

function touches(origin: Rect, rect: Rect, direction: Direction): boolean {
  switch (direction) {
    case "left":
      return Math.abs(rect.x + rect.width - origin.x) <= epsilon;
    case "right":
      return Math.abs(origin.x + origin.width - rect.x) <= epsilon;
    case "up":
      return Math.abs(rect.y + rect.height - origin.y) <= epsilon;
    case "down":
      return Math.abs(origin.y + origin.height - rect.y) <= epsilon;
  }
}

function perpendicularOverlap(origin: Rect, rect: Rect, direction: Direction): number {
  const horizontal = direction === "left" || direction === "right";
  const [start, end, otherStart, otherEnd] = horizontal
    ? [origin.y, origin.y + origin.height, rect.y, rect.y + rect.height]
    : [origin.x, origin.x + origin.width, rect.x, rect.x + rect.width];
  return Math.min(end, otherEnd) - Math.max(start, otherStart);
}

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}
