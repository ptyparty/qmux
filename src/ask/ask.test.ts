import { describe, expect, test } from "bun:test";
import { askOwner } from "./ask.ts";

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
