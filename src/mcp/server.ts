import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ask } from "../ask/ask.ts";
import { hostNames } from "../ask/hosts.ts";
import { AskStore } from "../ask/store.ts";
import { formSpec } from "../form/schema.ts";

const defaultWaitSeconds = 50;

const askDescription = `Ask the user questions in a form that pops up in their terminal (a popup in qmux, a floating pane in zellij, or a popup in tmux), and get their answers back as JSON.

Use it when you need a decision, a choice between options, or several answers at once. It is quicker for the user than typing replies in chat. Element types: text, confirm (yes/no), choice (single or multi, with an automatic "Other" free-text option), number (bounded), note (display-only text), markdown (display-only, rendered markdown for longer content), image (display-only, a picture such as a screenshot shown from a file path), and slides (several images the user pages through one at a time, leaving an optional note on each; the answer is one note per slide). Use \`when\` to show an element only when an earlier answer calls for it.

The result is {"status":"submitted","values":{...}} with one entry per visible element, {"status":"cancelled"} if the user dismissed the form, or {"status":"pending"} if they have not answered within wait_seconds. When it is pending, call the wait tool with the returned id.`;

export function createServer(store: AskStore = new AskStore()): McpServer {
  const server = new McpServer({ name: "qmux", version: "0.1.0" });

  server.registerTool(
    "ask",
    {
      title: "Ask the user",
      description: askDescription,
      inputSchema: {
        form: formSpec,
        wait_seconds: z.number().min(0).max(600).default(defaultWaitSeconds).describe("How long to wait for an answer before returning pending"),
        host: z.enum(hostNames).default("auto").describe("Where to show the form; auto detects qmux, zellij, or tmux"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ form, wait_seconds, host }) => {
      const outcome = await ask(store, form, host, wait_seconds * 1000);
      return reply({ id: outcome.id, host: outcome.launch.host, message: outcome.launch.message, ...outcome.status });
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for an answer",
      description: "Wait for the user to answer a form opened by the ask tool. Returns the same result shapes as ask.",
      inputSchema: {
        id: z.string().describe("The id returned by ask"),
        timeout_seconds: z.number().min(0).max(600).default(defaultWaitSeconds),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, timeout_seconds }) => reply({ id, ...(await store.wait(id, timeout_seconds * 1000)) }),
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function reply(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
