import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabDirs } from "./tab-dirs.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-tab-dirs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("TabDirs", () => {
  test("starting clears tab directories left by an earlier server", () => {
    const root = join(dir, "stale");
    mkdirSync(join(root, "7"), { recursive: true });
    writeFileSync(join(root, "7", "old.log"), "");
    new TabDirs(root);
    expect(existsSync(root)).toBe(false);
  });

  test("a tab's directory is made on demand and removed with the tab", () => {
    const dirs = new TabDirs(join(dir, "live"));
    const tab = dirs.tabDir(3);
    expect(existsSync(tab)).toBe(true);
    dirs.remove(3);
    expect(existsSync(tab)).toBe(false);
  });
});
