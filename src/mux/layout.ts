export type PaneId = number;
export type Axis = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";

export type LayoutNode =
  | { kind: "pane"; id: PaneId }
  | { kind: "split"; axis: Axis; children: WeightedNode[] }
  | { kind: "stack"; panes: PaneId[]; expanded: number };

export type WeightedNode = { node: LayoutNode; weight: number };

export type Rect = { x: number; y: number; width: number; height: number };

const epsilon = 1e-9;
const minimumWeight = 0.05;
const collapsedShare = 0.02;

export function leaf(id: PaneId): LayoutNode {
  return { kind: "pane", id };
}

export function splitPane(root: LayoutNode, target: PaneId, axis: Axis, added: PaneId): LayoutNode {
  return mapPaneParent(root, target, {
    inSplit: (split, index) => {
      if (split.axis !== axis) return undefined;
      const children = [...split.children];
      const half = children[index]!.weight / 2;
      children[index] = { ...children[index]!, weight: half };
      children.splice(index + 1, 0, { node: leaf(added), weight: half });
      return { ...split, children };
    },
    atPane: (pane) => ({ kind: "split", axis, children: [{ node: pane, weight: 0.5 }, { node: leaf(added), weight: 0.5 }] }),
  });
}

export function stackPane(root: LayoutNode, target: PaneId, added: PaneId): LayoutNode {
  const stack = stackContaining(root, target);
  if (stack) {
    const index = stack.panes.indexOf(target) + 1;
    const panes = [...stack.panes.slice(0, index), added, ...stack.panes.slice(index)];
    return replaceNode(root, stack, { kind: "stack", panes, expanded: index });
  }
  return mapPaneParent(root, target, {
    inSplit: () => undefined,
    atPane: (pane) => ({ kind: "stack", panes: [(pane as { id: PaneId }).id, added], expanded: 1 }),
  });
}

export function addToFirstStack(root: LayoutNode, added: PaneId): LayoutNode | undefined {
  const stack = firstStack(root);
  if (!stack) return undefined;
  return replaceNode(root, stack, { kind: "stack", panes: [...stack.panes, added], expanded: stack.panes.length });
}

export function expandPane(root: LayoutNode, target: PaneId): LayoutNode {
  const stack = stackContaining(root, target);
  if (!stack || stack.panes[stack.expanded] === target) return root;
  return replaceNode(root, stack, { ...stack, expanded: stack.panes.indexOf(target) });
}

export function removePane(root: LayoutNode, target: PaneId): LayoutNode | null {
  if (root.kind === "pane") return root.id === target ? null : root;
  if (root.kind === "stack") {
    const index = root.panes.indexOf(target);
    if (index < 0) return root;
    const panes = root.panes.filter((id) => id !== target);
    if (panes.length === 0) return null;
    if (panes.length === 1) return leaf(panes[0]!);
    const expanded = index < root.expanded ? root.expanded - 1 : Math.min(root.expanded, panes.length - 1);
    return { kind: "stack", panes, expanded };
  }
  const children = root.children
    .map((child) => ({ ...child, node: removePane(child.node, target) }))
    .filter((child): child is WeightedNode => child.node !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!.node;
  return { ...root, children: normalize(children) };
}

export function paneIds(root: LayoutNode): PaneId[] {
  switch (root.kind) {
    case "pane":
      return [root.id];
    case "stack":
      return root.panes;
    case "split":
      return root.children.flatMap((child) => paneIds(child.node));
  }
}

export function paneRects(root: LayoutNode, rect: Rect = { x: 0, y: 0, width: 1, height: 1 }): Map<PaneId, Rect> {
  if (root.kind === "pane") return new Map([[root.id, rect]]);
  if (root.kind === "stack") return stackRects(root, rect);
  const rects = new Map<PaneId, Rect>();
  let offset = 0;
  for (const child of root.children) {
    const childRect =
      root.axis === "row"
        ? { x: rect.x + offset * rect.width, y: rect.y, width: child.weight * rect.width, height: rect.height }
        : { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: child.weight * rect.height };
    offset += child.weight;
    for (const [id, paneRect] of paneRects(child.node, childRect)) rects.set(id, paneRect);
  }
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

export function growPane(root: LayoutNode, target: PaneId, direction: Direction, step: number): LayoutNode {
  return transfer(root, target, direction, step) ?? transfer(root, target, opposite(direction), -step) ?? root;
}

export function shrinkPane(root: LayoutNode, target: PaneId, direction: Direction, step: number): LayoutNode {
  return transfer(root, target, direction, -step) ?? root;
}

function transfer(root: LayoutNode, target: PaneId, direction: Direction, amount: number): LayoutNode | undefined {
  const axis: Axis = direction === "left" || direction === "right" ? "row" : "column";
  const towardStart = direction === "left" || direction === "up";
  const path = pathTo(root, target);
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const { split, index } = path[depth]!;
    if (split.axis !== axis) continue;
    const other = towardStart ? index - 1 : index + 1;
    if (other < 0 || other >= split.children.length) continue;
    const giver = amount > 0 ? split.children[other]! : split.children[index]!;
    const moved = Math.sign(amount) * Math.min(Math.abs(amount), giver.weight - minimumWeight);
    if (moved === 0 || Math.sign(moved) !== Math.sign(amount)) return root;
    const children = split.children.map((child, position) => {
      if (position === index) return { ...child, weight: child.weight + moved };
      if (position === other) return { ...child, weight: child.weight - moved };
      return child;
    });
    return replaceNode(root, split, { ...split, children });
  }
  return undefined;
}

function stackRects(stack: StackNode, rect: Rect): Map<PaneId, Rect> {
  const collapsed = Math.min(collapsedShare, 0.5 / stack.panes.length);
  const expanded = 1 - collapsed * (stack.panes.length - 1);
  const rects = new Map<PaneId, Rect>();
  let offset = 0;
  stack.panes.forEach((id, index) => {
    const share = index === stack.expanded ? expanded : collapsed;
    rects.set(id, { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: share * rect.height });
    offset += share;
  });
  return rects;
}

function stackContaining(root: LayoutNode, target: PaneId): StackNode | undefined {
  if (root.kind === "pane") return undefined;
  if (root.kind === "stack") return root.panes.includes(target) ? root : undefined;
  for (const child of root.children) {
    const found = stackContaining(child.node, target);
    if (found) return found;
  }
  return undefined;
}

function firstStack(root: LayoutNode): StackNode | undefined {
  if (root.kind === "stack") return root;
  if (root.kind === "pane") return undefined;
  for (const child of root.children) {
    const found = firstStack(child.node);
    if (found) return found;
  }
  return undefined;
}

function opposite(direction: Direction): Direction {
  return ({ left: "right", right: "left", up: "down", down: "up" } as const)[direction];
}

function normalize(children: WeightedNode[]): WeightedNode[] {
  const total = children.reduce((sum, child) => sum + child.weight, 0);
  return children.map((child) => ({ ...child, weight: child.weight / total }));
}

type SplitNode = Extract<LayoutNode, { kind: "split" }>;
export type StackNode = Extract<LayoutNode, { kind: "stack" }>;

function mapPaneParent(
  root: LayoutNode,
  target: PaneId,
  handlers: { inSplit: (split: SplitNode, index: number) => LayoutNode | undefined; atPane: (pane: LayoutNode) => LayoutNode },
): LayoutNode {
  if (root.kind === "pane") return root.id === target ? handlers.atPane(root) : root;
  if (root.kind === "stack") return root.panes.includes(target) ? handlers.atPane(root) : root;
  const index = root.children.findIndex((child) => child.node.kind === "pane" && child.node.id === target);
  if (index >= 0) {
    const replaced = handlers.inSplit(root, index);
    if (replaced) return replaced;
  }
  return { ...root, children: root.children.map((child) => ({ ...child, node: mapPaneParent(child.node, target, handlers) })) };
}

function pathTo(root: LayoutNode, target: PaneId): { split: SplitNode; index: number }[] {
  if (root.kind !== "split") return [];
  for (const [index, child] of root.children.entries()) {
    if (!paneIds(child.node).includes(target)) continue;
    return [{ split: root, index }, ...pathTo(child.node, target)];
  }
  return [];
}

function replaceNode(root: LayoutNode, from: LayoutNode, to: LayoutNode): LayoutNode {
  if (root === from) return to;
  if (root.kind !== "split") return root;
  return { ...root, children: root.children.map((child) => ({ ...child, node: replaceNode(child.node, from, to) })) };
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
