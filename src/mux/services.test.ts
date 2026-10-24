import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabServices } from "./services.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-services-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

describe("TabServices", () => {
  test("starting clears tab directories left by an earlier server", () => {
    const root = join(dir, "stale");
    mkdirSync(join(root, "7"), { recursive: true });
    writeFileSync(join(root, "7", "old.log"), "");
    new TabServices(root, () => ({}), () => {});
    expect(existsSync(root)).toBe(false);
  });

  test("a service sees the tab directory, logs there, and stopping kills everything it started", async () => {
    const root = join(dir, "run");
    const services = new TabServices(root, () => ({ PATH: process.env.PATH }), () => {
      throw new Error("a stopped service is not a failure");
    });
    const pidFile = join(dir, "grandchild.pid");
    services.start(1, [{ name: "server", command: ["sh", "-c", `echo "dir=$QMUX_TAB_DIR"; sleep 30 & echo $! > ${pidFile}; wait`] }], dir);
    const log = join(root, "1", "server.log");
    expect(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    expect(await eventually(() => readFileSync(log, "utf8").includes(`dir=${join(root, "1")}`))).toBe(true);
    await services.stop(1);
    expect(await eventually(() => !alive(grandchild))).toBe(true);
    expect(existsSync(join(root, "1"))).toBe(false);
  });

  test("a service that exits on its own is reported with its log", async () => {
    const root = join(dir, "fail");
    const failures: string[] = [];
    const services = new TabServices(root, () => ({ PATH: process.env.PATH }), (tabId, name, detail) => failures.push(`${tabId} ${name} ${detail}`));
    services.start(2, [{ command: ["sh", "-c", "echo boom; exit 3"] }], dir);
    expect(await eventually(() => failures.length > 0)).toBe(true);
    expect(failures).toEqual([`2 sh exited with code 3; see ${join(root, "2", "sh.log")}`]);
    expect(readFileSync(join(root, "2", "sh.log"), "utf8")).toBe("boom\n");
    await services.stopAll();
  });
});
