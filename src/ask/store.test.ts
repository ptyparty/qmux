import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFormSpec } from "../form/schema.ts";
import { UnsafeDirectoryError } from "../private-dir.ts";
import { AskStore, UnknownAskError } from "./store.ts";

const spec = parseFormSpec({ title: "Pick", elements: [{ type: "confirm", id: "ok", label: "OK?" }] });

let root: string;
let store: AskStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qmux-store-"));
  store = new AskStore(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("AskStore", () => {
  test("a new ask is pending and keeps its spec", async () => {
    const meta = await store.create(spec, "zellij");
    expect(meta).toMatchObject({ title: "Pick", host: "zellij" });
    expect(await store.status(meta.id)).toEqual({ status: "pending" });
    expect(await store.spec(meta.id)).toEqual(spec);
    expect((await store.pending()).map((pending) => pending.id)).toEqual([meta.id]);
  });

  test("the first completion wins", async () => {
    const { id } = await store.create(spec, "none");
    expect(await store.complete(id, { status: "submitted", values: { ok: true } })).toBe(true);
    expect(await store.complete(id, { status: "cancelled" })).toBe(false);
    expect(await store.status(id)).toEqual({ status: "submitted", values: { ok: true } });
    expect(await store.pending()).toEqual([]);
  });

  test("wait returns once the ask is answered", async () => {
    const { id } = await store.create(spec, "none");
    setTimeout(() => store.complete(id, { status: "cancelled" }), 50);
    expect(await store.wait(id, 2000, 10)).toEqual({ status: "cancelled" });
  });

  test("wait gives up after the timeout", async () => {
    const { id } = await store.create(spec, "none");
    const started = Date.now();
    expect(await store.wait(id, 60, 10)).toEqual({ status: "pending" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("unknown or malformed ids are rejected", async () => {
    await expect(store.status("abc-00000000")).rejects.toThrow(UnknownAskError);
    await expect(store.status("../../etc")).rejects.toThrow(UnknownAskError);
  });

  test("asks older than a day are pruned when a new one is created", async () => {
    const old = await store.create(spec, "none");
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(join(root, old.id), dayAgo, dayAgo);
    await store.create(spec, "none");
    await expect(store.status(old.id)).rejects.toThrow(UnknownAskError);
  });

  test("remove deletes an ask", async () => {
    const { id } = await store.create(spec, "none");
    store.remove(id);
    await expect(store.status(id)).rejects.toThrow(UnknownAskError);
  });

  test("refuses a root that others can access", () => {
    chmodSync(root, 0o777);
    expect(() => new AskStore(root)).toThrow(UnsafeDirectoryError);
  });
});
