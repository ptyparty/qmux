import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, runtimeDir } from "../private-dir.ts";

export const controlRequest = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("popup.open"),
    params: z.object({ title: z.string(), command: z.array(z.string()).min(1) }),
  }),
]);

export type ControlRequest = z.infer<typeof controlRequest>;
export type ControlResponse = { ok: true } | { ok: false; error: string };
export type ControlHandler = (request: ControlRequest) => ControlResponse | Promise<ControlResponse>;

export class ControlError extends Error {}

export function controlSocketPath(): string {
  return join(ensurePrivateDir(join(runtimeDir(), "sockets")), `mux-${process.pid}.sock`);
}

export function serveControl(path: string, handler: ControlHandler): { stop: () => void } {
  rmSync(path, { force: true });
  const buffers = new WeakMap<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      async data(socket, data) {
        const text = (buffers.get(socket) ?? "") + data.toString();
        const lines = text.split("\n");
        buffers.set(socket, lines.pop()!);
        for (const line of lines) {
          if (line.trim() === "") continue;
          socket.write(`${JSON.stringify(await respond(line, handler))}\n`);
        }
      },
    },
  });
  return {
    stop: () => {
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
}

export async function sendControl(path: string, request: ControlRequest, timeoutMs = 3000): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => reject(new ControlError(`qmux did not answer on ${path}`)), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)) as ControlResponse);
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(new ControlError(`could not reach qmux on ${path}: ${error.message}`));
        },
      },
    }).catch((error: Error) => {
      clearTimeout(timer);
      reject(new ControlError(`could not reach qmux on ${path}: ${error.message}`));
    });
  });
}

async function respond(line: string, handler: ControlHandler): Promise<ControlResponse> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, error: "request is not valid JSON" };
  }
  const parsed = controlRequest.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  try {
    return await handler(parsed.data);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
