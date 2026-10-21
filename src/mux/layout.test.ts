import { describe, expect, test } from "bun:test";
import { addToFirstStack, expandPane, growPane, leaf, neighbor, paneIds, paneRects, removePane, shrinkPane, splitPane, stackPane, type LayoutNode } from "./layout.ts";

function grid(): LayoutNode {
  let root = leaf(1);
  root = splitPane(root, 1, "row", 2);
  root = splitPane(root, 2, "column", 3);
  return root;
}

describe("layout", () => {
  test("splitting a pane in the same axis adds a sibling and halves the pane", () => {
    let root = splitPane(leaf(1), 1, "row", 2);
    root = splitPane(root, 2, "row", 3);
    expect(paneIds(root)).toEqual([1, 2, 3]);
    expect([...paneRects(root).values()].map((rect) => rect.width)).toEqual([0.5, 0.25, 0.25]);
  });

  test("splitting across the axis nests a new split", () => {
    const root = grid();
    expect(paneRects(root)).toEqual(
      new Map([
        [1, { x: 0, y: 0, width: 0.5, height: 1 }],
        [2, { x: 0.5, y: 0, width: 0.5, height: 0.5 }],
        [3, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
      ]),
    );
  });

  test("removing a pane collapses single-child splits and renormalizes", () => {
    const root = removePane(grid(), 3)!;
    expect(root).toEqual({
      kind: "split",
      axis: "row",
      children: [
        { node: leaf(1), weight: 0.5 },
        { node: leaf(2), weight: 0.5 },
      ],
    });
    expect(removePane(removePane(root, 2)!, 1)).toBeNull();
  });

  test("neighbors follow geometry", () => {
    const root = grid();
    expect(neighbor(root, 1, "right")).toBe(2);
    expect(neighbor(root, 2, "down")).toBe(3);
    expect(neighbor(root, 3, "left")).toBe(1);
    expect(neighbor(root, 3, "up")).toBe(2);
    expect(neighbor(root, 1, "left")).toBeUndefined();
    expect(neighbor(root, 2, "right")).toBeUndefined();
  });

  test("growing takes room from the neighbor on that side", () => {
    expect(paneRects(growPane(grid(), 1, "right", 0.1)).get(1)!.width).toBeCloseTo(0.6);
    expect(paneRects(growPane(grid(), 3, "up", 0.1)).get(3)!.height).toBeCloseTo(0.6);
  });

  test("growing toward an outer edge moves the other border instead", () => {
    expect(paneRects(growPane(grid(), 1, "left", 0.1)).get(1)!.width).toBeCloseTo(0.4);
    expect(paneRects(growPane(grid(), 2, "right", 0.1)).get(2)!.width).toBeCloseTo(0.4);
    expect(paneRects(growPane(grid(), 2, "up", 0.1)).get(2)!.height).toBeCloseTo(0.4);
  });

  test("shrinking gives room to the neighbor on that side", () => {
    expect(paneRects(shrinkPane(grid(), 1, "right", 0.1)).get(1)!.width).toBeCloseTo(0.4);
    expect(paneRects(shrinkPane(grid(), 2, "left", 0.1)).get(2)!.width).toBeCloseTo(0.4);
    expect(shrinkPane(grid(), 1, "left", 0.1)).toEqual(grid());
  });

  test("resizing stops at the minimum size", () => {
    let root = grid();
    for (let i = 0; i < 20; i++) root = growPane(root, 1, "right", 0.1);
    expect(paneRects(root).get(2)!.width).toBeCloseTo(0.05);
    for (let i = 0; i < 20; i++) root = shrinkPane(root, 1, "right", 0.1);
    expect(paneRects(root).get(1)!.width).toBeCloseTo(0.05);
  });

  describe("stacks", () => {
    function ide(): LayoutNode {
      return { kind: "split", axis: "row", children: [{ node: leaf(1), weight: 0.5 }, { node: { kind: "stack", panes: [2, 3], expanded: 0 }, weight: 0.5 }] };
    }

    test("stacking a plain pane turns it into a stack with the new pane expanded", () => {
      expect(stackPane(leaf(1), 1, 2)).toEqual({ kind: "stack", panes: [1, 2], expanded: 1 });
    });

    test("stacking onto a stacked pane inserts after it", () => {
      expect(stackPane(ide(), 2, 4)).toMatchObject({ children: [{}, { node: { panes: [2, 4, 3], expanded: 1 } }] });
    });

    test("new panes can join the first stack", () => {
      expect(addToFirstStack(ide(), 4)).toMatchObject({ children: [{}, { node: { panes: [2, 3, 4], expanded: 2 } }] });
      expect(addToFirstStack(leaf(1), 2)).toBeUndefined();
    });

    test("focus moves through stack members and sideways lands on the expanded one", () => {
      expect(neighbor(ide(), 2, "down")).toBe(3);
      expect(neighbor(ide(), 3, "up")).toBe(2);
      expect(neighbor(ide(), 1, "right")).toBe(2);
      expect(neighbor(expandPane(ide(), 3), 1, "right")).toBe(3);
    });

    test("expanding a member", () => {
      expect(expandPane(ide(), 3)).toMatchObject({ children: [{}, { node: { expanded: 1 } }] });
    });

    test("removing members keeps the expanded pane sensible and collapses a single member", () => {
      const three: LayoutNode = { kind: "stack", panes: [1, 2, 3], expanded: 2 };
      expect(removePane(three, 1)).toEqual({ kind: "stack", panes: [2, 3], expanded: 1 });
      expect(removePane(three, 3)).toEqual({ kind: "stack", panes: [1, 2], expanded: 1 });
      expect(removePane(ide(), 3)).toMatchObject({ children: [{}, { node: leaf(2) }] });
    });

    test("splitting a stacked pane splits beside the whole stack", () => {
      const root = splitPane(ide(), 3, "column", 4);
      expect(paneIds(root)).toEqual([1, 2, 3, 4]);
      expect(root).toMatchObject({ children: [{}, { node: { kind: "split", axis: "column", children: [{ node: { kind: "stack" } }, { node: leaf(4) }] } }] });
    });

    test("the focused member is shown even when the stack remembers another", () => {
      const rects = paneRects(ide(), undefined, 3);
      expect(rects.get(3)!.height).toBeGreaterThan(0.9);
      expect(rects.get(2)!.height).toBeLessThan(0.1);
      expect(neighbor(ide(), 3, "up")).toBe(2);
    });

    test("splitting a stacked pane along the parent's axis adds a sibling to that split", () => {
      const root = splitPane(ide(), 3, "row", 4);
      expect(root).toMatchObject({ kind: "split", axis: "row", children: [{ node: leaf(1) }, { node: { kind: "stack" } }, { node: leaf(4) }] });
    });

    test("stacks resize like any other pane", () => {
      expect(paneRects(growPane(ide(), 2, "left", 0.1)).get(1)!.width).toBeCloseTo(0.4);
    });
  });
});
