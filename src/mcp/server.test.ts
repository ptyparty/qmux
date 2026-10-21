import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../ask/store.ts";
import { createServer } from "./server.ts";

let root: string;
let store: AskStore;
let client: Client;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "qmux-mcp-"));
  store = new AskStore(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const form = { title: "Pick", elements: [{ type: "confirm", id: "ok", label: "OK?" }] };

describe("MCP server", () => {
  test("lists ask and wait", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["ask", "wait"]);
  });

  test("ask returns pending, and wait returns the answer", async () => {
    const asked = await client.callTool({ name: "ask", arguments: { form, host: "none", wait_seconds: 0 } });
    expect(asked.structuredContent).toMatchObject({ host: "none", status: "pending" });
    const id = (asked.structuredContent as { id: string }).id;
    setTimeout(() => store.complete(id, { status: "submitted", values: { ok: true } }), 50);
    const waited = await client.callTool({ name: "wait", arguments: { id, timeout_seconds: 5 } });
    expect(waited.structuredContent).toEqual({ id, status: "submitted", values: { ok: true } });
  });

  test("invalid forms are rejected with the validation problem", async () => {
    const result = await client.callTool({
      name: "ask",
      arguments: { form: { title: "x", elements: [{ type: "text", id: "a", label: "A", when: "b" }] }, host: "none" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("b is not an earlier element");
  });
});
