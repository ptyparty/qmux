import { describe, expect, test } from "bun:test";
import {
  addPaneTab,
  addToFirstTabs,
  inPaneTabs,
  leaf,
  neighbor,
  paneIds,
  paneRects,
  paneTabSibling,
  removePane,
  selectPaneTab,
  splitPane,
  type LayoutNode,
} from "./layout.ts";

function grid(): LayoutNode {
  let root = leaf(1);
  root = splitPane(root, 1, "row", 2);
  root = splitPane(root, 2, "column", 3);
  return root;
}

describe("layout", () => {
  test("splitting a pane in the same axis adds a sibling and siblings share the space equally", () => {
    let root = splitPane(leaf(1), 1, "row", 2);
    root = splitPane(root, 2, "row", 3);
    expect(paneIds(root)).toEqual([1, 2, 3]);
    expect([...paneRects(root).values()].map((rect) => rect.width)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("splitting across the axis nests a new split", () => {
    expect(paneRects(grid())).toEqual(
      new Map([
        [1, { x: 0, y: 0, width: 0.5, height: 1 }],
        [2, { x: 0.5, y: 0, width: 0.5, height: 0.5 }],
        [3, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
      ]),
    );
  });

  test("removing a pane collapses single-child splits and the rest share the space", () => {
    const root = removePane(grid(), 3)!;
    expect(root).toEqual({ kind: "split", axis: "row", children: [leaf(1), leaf(2)] });
    expect(removePane(removePane(root, 2)!, 1)).toBeNull();
    const three = splitPane(splitPane(leaf(1), 1, "row", 2), 2, "row", 3);
    expect([...paneRects(removePane(three, 2)!).values()].map((rect) => rect.width)).toEqual([0.5, 0.5]);
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

  describe("pane tabs", () => {
    function ide(): LayoutNode {
      return { kind: "split", axis: "row", children: [leaf(1), { kind: "tabs", panes: [2, 3], selected: 0 }] };
    }

    test("adding a pane tab to a plain pane turns it into a group with the new pane selected", () => {
      expect(addPaneTab(leaf(1), 1, 2)).toEqual({ kind: "tabs", panes: [1, 2], selected: 1 });
    });

    test("adding a pane tab inside a group inserts it after the focused one", () => {
      expect(addPaneTab(ide(), 2, 4)).toMatchObject({ children: [{}, { panes: [2, 4, 3], selected: 1 }] });
    });

    test("new panes can join the first group", () => {
      expect(addToFirstTabs(ide(), 4)).toMatchObject({ children: [{}, { panes: [2, 3, 4], selected: 2 }] });
      expect(addToFirstTabs(leaf(1), 2)).toBeUndefined();
    });

    test("for focus, only the shown member of a group takes up space", () => {
      const showingSecond: LayoutNode = { kind: "split", axis: "row", children: [leaf(1), { kind: "tabs", panes: [2, 3], selected: 1 }] };
      expect(neighbor(ide(), 1, "right")).toBe(2);
      expect(neighbor(showingSecond, 1, "right")).toBe(3);
      expect(neighbor(ide(), 2, "right")).toBeUndefined();
      expect(neighbor(ide(), 2, "left")).toBe(1);
      expect(neighbor(ide(), 2, "down")).toBeUndefined();
      expect(paneRects(ide()).get(2)).toMatchObject({ x: 0.5, width: 0.5 });
      expect(paneRects(ide()).has(3)).toBe(false);
    });

    test("a pane can tell whether it is in a group", () => {
      expect(inPaneTabs(ide(), 3)).toBe(true);
      expect(inPaneTabs(ide(), 1)).toBe(false);
    });

    test("selecting a member", () => {
      expect(selectPaneTab(ide(), 3)).toMatchObject({ children: [{}, { selected: 1 }] });
    });

    test("a closing member hands focus to a sibling in its group", () => {
      expect(paneTabSibling(ide(), 2)).toBe(3);
      expect(paneTabSibling(ide(), 3)).toBe(2);
      expect(paneTabSibling(ide(), 1)).toBeUndefined();
    });

    test("removing members keeps the selection sensible and collapses a single member", () => {
      const three: LayoutNode = { kind: "tabs", panes: [1, 2, 3], selected: 2 };
      expect(removePane(three, 1)).toEqual({ kind: "tabs", panes: [2, 3], selected: 1 });
      expect(removePane(three, 3)).toEqual({ kind: "tabs", panes: [1, 2], selected: 1 });
      expect(removePane(ide(), 3)).toMatchObject({ children: [{}, leaf(2)] });
    });

    test("splitting a pane in a group splits beside the whole group", () => {
      const root = splitPane(ide(), 3, "column", 4);
      expect(paneIds(root)).toEqual([1, 2, 3, 4]);
      expect(root).toMatchObject({ children: [{}, { kind: "split", axis: "column", children: [{ kind: "tabs" }, leaf(4)] }] });
    });

    test("splitting a pane in a group along the parent's axis adds a sibling to that split", () => {
      expect(splitPane(ide(), 3, "row", 4)).toMatchObject({ kind: "split", axis: "row", children: [leaf(1), { kind: "tabs" }, leaf(4)] });
    });
  });
});
