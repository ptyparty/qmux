import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedPaneEnv } from "./attached.ts";

const proc = mkdtempSync(join(tmpdir(), "qmux-proc-"));
afterAll(() => rmSync(proc, { recursive: true, force: true }));

function fakeProcess(pid: number, argv: string[], env: string[]): void {
  mkdirSync(join(proc, String(pid)));
  writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
  writeFileSync(join(proc, String(pid), "environ"), `${env.join("\0")}\0`);
}

fakeProcess(10, ["/home/me/.local/bin/claude", "--session-id", "e3002ad1-66a9"], ["HOME=/home/me"]);
fakeProcess(11, ["/home/me/.local/bin/claude", "attach", "e3002ad1"], ["QMUX_SOCKET=/run/q.sock", "QMUX_PANE_ID=7", "A=b=c"]);
fakeProcess(12, ["/home/me/.local/bin/claude", "attach", "ffff0000"], ["QMUX_SOCKET=/run/other.sock", "QMUX_PANE_ID=3"]);
writeFileSync(join(proc, "uptime"), "");

describe("attachedPaneEnv", () => {
  test("finds the pane of a claude attach for the session, by full id or short prefix", () => {
    expect(attachedPaneEnv("e3002ad1-66a9-4a1c-bfd1-4e460c7fbaad", proc)).toEqual({ QMUX_SOCKET: "/run/q.sock", QMUX_PANE_ID: "7" });
  });

  test("gives nothing when no attached viewer is in qmux", () => {
    expect(attachedPaneEnv("abcdef12-0000", proc)).toBeUndefined();
    expect(attachedPaneEnv(undefined, proc)).toBeUndefined();
    expect(attachedPaneEnv("e300", proc)).toBeUndefined();
  });
});
