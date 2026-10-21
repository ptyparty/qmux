import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlError, sendControl, serveControl, type ControlRequest } from "./control.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-control-"));
const path = join(dir, "mux.sock");
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  rmSync(path, { force: true });
});

describe("control socket", () => {
  test("delivers requests to the handler and returns its response", async () => {
    const received: ControlRequest[] = [];
    stop = serveControl(path, (request) => {
      received.push(request);
      return { ok: true };
    }).stop;
    const request: ControlRequest = { method: "popup.open", params: { title: "Pick", command: ["true"] } };
    expect(await sendControl(path, request)).toEqual({ ok: true });
    expect(received).toEqual([request]);
  });

  test("rejects malformed requests without calling the handler", async () => {
    stop = serveControl(path, () => {
      throw new Error("should not be called");
    }).stop;
    const response = await sendControl(path, { method: "popup.open", params: { title: "x", command: [] } } as ControlRequest);
    expect(response.ok).toBe(false);
  });

  test("handler errors come back as failed responses", async () => {
    stop = serveControl(path, () => {
      throw new Error("no room");
    }).stop;
    expect(await sendControl(path, { method: "popup.open", params: { title: "x", command: ["true"] } })).toEqual({ ok: false, error: "no room" });
  });

  test("a missing socket is a ControlError", async () => {
    await expect(sendControl(join(dir, "missing.sock"), { method: "popup.open", params: { title: "x", command: ["true"] } })).rejects.toThrow(ControlError);
  });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
