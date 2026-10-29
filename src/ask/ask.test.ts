import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFormSpec } from "../form/schema.ts";
import { ask, askOwner } from "./ask.ts";
import { AskStore } from "./store.ts";

describe("ask", () => {
  test("a withdrawn ask ends cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "qmux-ask-"));
    try {
      const withdraw = new AbortController();
      const spec = parseFormSpec({ title: "Pick", elements: [{ type: "confirm", id: "ok", label: "OK?" }] });
      const outcome = ask(new AskStore(root), spec, "none", 5000, { signal: withdraw.signal });
      withdraw.abort();
      expect((await outcome).status).toEqual({ status: "cancelled" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("askOwner", () => {
  test("names the pane and the qmux server run asking", () => {
    expect(askOwner({ QMUX_SOCKET: "/run/q.sock", QMUX_PANE_ID: "7", QMUX_SERVER_ID: "abc" })).toEqual({ socket: "/run/q.sock", paneId: 7, server: "abc" });
    expect(askOwner({ QMUX_SOCKET: "/run/q.sock", QMUX_PANE_ID: "7" })).toEqual({ socket: "/run/q.sock", paneId: 7 });
  });

  test("gives nothing outside a qmux pane", () => {
    expect(askOwner({ QMUX_SOCKET: "/run/q.sock", QMUX_PANE_ID: "" })).toBeUndefined();
    expect(askOwner({ QMUX_SOCKET: "/run/q.sock", QMUX_PANE_ID: "x" })).toBeUndefined();
    expect(askOwner({ QMUX_PANE_ID: "7" })).toBeUndefined();
  });
});
