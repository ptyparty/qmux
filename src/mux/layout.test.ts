import { describe, expect, test } from "bun:test";
import { addToFirstTabs, selectPaneTab, growPane, leaf, neighbor, paneIds, paneRects, removePane, shrinkPane, splitPane, addPaneTab, type LayoutNode } from "./layout.ts";

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

  describe("pane tabs", () => {
    function ide(): LayoutNode {
      return { kind: "split", axis: "row", children: [{ node: leaf(1), weight: 0.5 }, { node: { kind: "tabs", panes: [2, 3], selected: 0 }, weight: 0.5 }] };
    }

    test("adding a pane tab to a plain pane turns it into a group with the new pane selected", () => {
      expect(addPaneTab(leaf(1), 1, 2)).toEqual({ kind: "tabs", panes: [1, 2], selected: 1 });
    });

    test("adding a pane tab inside a group inserts it after the focused one", () => {
      expect(addPaneTab(ide(), 2, 4)).toMatchObject({ children: [{}, { node: { panes: [2, 4, 3], selected: 1 } }] });
    });

    test("new panes can join the first group", () => {
      expect(addToFirstTabs(ide(), 4)).toMatchObject({ children: [{}, { node: { panes: [2, 3, 4], selected: 2 } }] });
      expect(addToFirstTabs(leaf(1), 2)).toBeUndefined();
    });

    test("for focus, group members sit side by side", () => {
      expect(neighbor(ide(), 1, "right")).toBe(2);
      expect(neighbor(ide(), 2, "right")).toBe(3);
      expect(neighbor(ide(), 3, "left")).toBe(2);
      expect(neighbor(ide(), 2, "left")).toBe(1);
      expect(neighbor(ide(), 3, "up")).toBeUndefined();
      expect(neighbor(ide(), 2, "down")).toBeUndefined();
    });

    test("expanding a member", () => {
      expect(selectPaneTab(ide(), 3)).toMatchObject({ children: [{}, { node: { selected: 1 } }] });
    });

    test("removing members keeps the selected pane sensible and collapses a single member", () => {
      const three: LayoutNode = { kind: "tabs", panes: [1, 2, 3], selected: 2 };
      expect(removePane(three, 1)).toEqual({ kind: "tabs", panes: [2, 3], selected: 1 });
      expect(removePane(three, 3)).toEqual({ kind: "tabs", panes: [1, 2], selected: 1 });
      expect(removePane(ide(), 3)).toMatchObject({ children: [{}, { node: leaf(2) }] });
    });

    test("splitting a pane in a group splits beside the whole group", () => {
      const root = splitPane(ide(), 3, "column", 4);
      expect(paneIds(root)).toEqual([1, 2, 3, 4]);
      expect(root).toMatchObject({ children: [{}, { node: { kind: "split", axis: "column", children: [{ node: { kind: "tabs" } }, { node: leaf(4) }] } }] });
    });

    test("splitting a pane in a group along the parent's axis adds a sibling to that split", () => {
      const root = splitPane(ide(), 3, "row", 4);
      expect(root).toMatchObject({ kind: "split", axis: "row", children: [{ node: leaf(1) }, { node: { kind: "tabs" } }, { node: leaf(4) }] });
    });

    test("groups resize like any other pane", () => {
      expect(paneRects(growPane(ide(), 2, "left", 0.1)).get(1)!.width).toBeCloseTo(0.4);
    });
  });
});
