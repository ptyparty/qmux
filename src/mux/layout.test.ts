import { describe, expect, test } from "bun:test";
import { leaf, neighbor, paneIds, paneRects, removePane, resizePane, splitPane, type LayoutNode } from "./layout.ts";

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

  test("resizing moves weight from the neighbor in that direction", () => {
    const root = resizePane(grid(), 1, "right", 0.1);
    expect(paneRects(root).get(1)!.width).toBeCloseTo(0.6);
    expect(paneRects(resizePane(grid(), 3, "up", 0.1)).get(3)!.height).toBeCloseTo(0.6);
    expect(resizePane(grid(), 1, "left", 0.1)).toEqual(grid());
  });

  test("resizing stops at the minimum size", () => {
    let root = grid();
    for (let i = 0; i < 20; i++) root = resizePane(root, 1, "right", 0.1);
    expect(paneRects(root).get(2)!.width).toBeCloseTo(0.05);
  });
});
