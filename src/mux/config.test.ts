import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, planLayout } from "./config.ts";
import { paneRects } from "./layout.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("config", () => {
  test("a missing file gives the defaults", async () => {
    expect(await loadConfig(join(dir, "missing.ts"))).toEqual({ config: defaultConfig });
  });

  test("loads layouts and projects from a TypeScript module", async () => {
    const path = writeConfig(
      "good.ts",
      `export default {
        projects: { roots: ["~/work/*/*"], layout: "ide" },
        layouts: { ide: { row: [{ command: ["dev", "claude"], focus: true }, { column: [{ command: ["remax"] }, {}] }] } },
      };`,
    );
    const { config, error } = await loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.projects.layout).toBe("ide");
    expect(Object.keys(config.layouts)).toEqual(["ide"]);
  });

  test("invalid config falls back to defaults with an error", async () => {
    const path = writeConfig("bad.ts", `export default { projects: { layout: "nope" }, colours: true };`);
    const { config, error } = await loadConfig(path);
    expect(config).toEqual(defaultConfig);
    expect(error).toContain("colours");
  });

  test("a config that throws falls back to defaults with an error", async () => {
    const { error } = await loadConfig(writeConfig("throws.ts", `throw new Error("boom");`));
    expect(error).toContain("boom");
  });

  test("planning a stack", () => {
    let next = 1;
    const plan = planLayout({ row: [{}, { stack: [{ command: ["remax"] }, {}] }] }, () => next++);
    expect(plan.root).toEqual({
      kind: "split",
      axis: "row",
      children: [
        { node: { kind: "pane", id: 1 }, weight: 0.5 },
        { node: { kind: "stack", panes: [2, 3], expanded: 0 }, weight: 0.5 },
      ],
    });
  });

  test("a focused stack member is the one the stack shows", () => {
    let next = 1;
    const plan = planLayout({ stack: [{}, { focus: true }] }, () => next++);
    expect(plan.root).toEqual({ kind: "stack", panes: [1, 2], expanded: 1 });
    expect(plan.focus).toBe(2);
  });

  test("planning a layout allocates panes, honours sizes, and picks the focus", () => {
    let next = 10;
    const plan = planLayout({ row: [{ command: ["dev", "claude"], size: 2 }, { column: [{ command: ["remax"] }, { focus: true }] }] }, () => next++);
    expect(plan.panes).toEqual([
      { id: 10, command: ["dev", "claude"], name: undefined },
      { id: 11, command: ["remax"], name: undefined },
      { id: 12, command: undefined, name: undefined },
    ]);
    expect(plan.focus).toBe(12);
    const rects = paneRects(plan.root);
    expect(rects.get(10)!.width).toBeCloseTo(2 / 3);
    expect(rects.get(12)).toMatchObject({ y: 0.5, height: 0.5 });
  });
});
