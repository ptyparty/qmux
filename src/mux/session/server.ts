import { createCliRenderer, type CliRenderer } from "@opentui/core";
import type { Socket } from "bun";
import { rmSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { serveControl } from "../control.ts";
import { loadConfig } from "../config.ts";
import { GraphicsRelay } from "../graphics.ts";
import { createMux, type Mux } from "../mux.ts";
import { encodeFrame, FrameDecoder, type Frame, type Goodbye, type Hello, type Size } from "./protocol.ts";
import { tryLock } from "./lock.ts";
import { sessionPaths, SessionError, type SessionPaths } from "./sessions.ts";
import { SocketWriter } from "./socket-writer.ts";

type Client = { decoder: FrameDecoder; writer: SocketWriter; size: Size | undefined; closed: boolean };
type ClientSocket = Socket<Client>;

const clearScreen = new TextEncoder().encode("\x1b[H\x1b[2J");

class RelayOutput extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  targets = new Set<ClientSocket>();

  constructor(private readonly send: (socket: ClientSocket, bytes: Uint8Array) => void) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    for (const socket of this.targets) this.send(socket, chunk);
    callback();
  }
}

export async function runServer(name: string): Promise<void> {
  const paths = sessionPaths(name);
  await claimSockets(name, paths);

  const send = (socket: ClientSocket, frame: Frame) => {
    if (!socket.data.closed) socket.data.writer.write(encodeFrame(frame));
  };
  const output = new RelayOutput((socket, bytes) => send(socket, { type: "output", body: bytes }));
  const input = new Readable({ read() {} });
  const clients = new Set<ClientSocket>();
  const graphics = new GraphicsRelay((bytes) => {
    for (const client of clients) send(client, { type: "output", body: bytes });
  });
  let renderer: CliRenderer | undefined;
  let mux: Mux | undefined;
  let lastTyped: ClientSocket | undefined;
  let quitting = false;
  let queue = Promise.resolve();

  const serialize = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => console.error(error));
  };

  const say = (socket: ClientSocket, goodbye: Goodbye) => {
    send(socket, { type: "goodbye", body: goodbye });
    socket.data.writer.endWhenFlushed();
  };

  const applySize = () => {
    if (!renderer || clients.size === 0) return;
    const sizes = [...clients].map((client) => client.data.size!);
    const cols = Math.min(...sizes.map((size) => size.cols));
    const rows = Math.min(...sizes.map((size) => size.rows));
    output.columns = cols;
    output.rows = rows;
    for (const client of clients) send(client, { type: "output", body: clearScreen });
    renderer.resize(cols, rows);
  };

  const clientsChanged = () => {
    output.targets = new Set(clients);
    mux?.setClients(clients.size);
    applySize();
  };

  const attach = async (socket: ClientSocket, hello: Hello) => {
    if (socket.data.closed || quitting) return;
    socket.data.size = { cols: hello.cols, rows: hello.rows };
    if (!renderer) {
      clients.add(socket);
      output.targets = new Set(clients);
      output.columns = hello.cols;
      output.rows = hello.rows;
      renderer = await createCliRenderer({
        stdin: input as unknown as NodeJS.ReadStream,
        stdout: output as unknown as NodeJS.WriteStream,
        width: hello.cols,
        height: hello.rows,
        environment: { ...hello.env, OPENTUI_FORCE_EXPLICIT_WIDTH: "0" },
        exitOnCtrlC: false,
        exitSignals: [],
        targetFps: 120,
        maxFps: 120,
        useMouse: true,
      });
      const { config, error } = await loadConfig();
      if (error) console.error(error);
      mux = createMux(renderer, {
        session: name,
        controlSocket: paths.control,
        config,
        configError: error && "Could not load the qmux config; see the session log",
        graphics,
        onDetach: () => serialize(() => release(lastTyped, { reason: "detached", message: `Detached from session ${name}` })),
        onQuit: () => serialize(quit),
      });
      clientsChanged();
      return;
    }
    output.targets = new Set();
    await renderer.suspend();
    if (!socket.data.closed) clients.add(socket);
    output.targets = new Set(clients);
    if (clients.size > 0) await renderer.resume();
    if (clients.has(socket)) for (const bytes of graphics.replay()) send(socket, { type: "output", body: bytes });
    clientsChanged();
  };

  const release = async (socket: ClientSocket | undefined, goodbye: Goodbye | undefined) => {
    if (!socket || !clients.has(socket)) {
      if (socket && goodbye) say(socket, goodbye);
      return;
    }
    if (renderer && !renderer.isDestroyed) {
      output.targets = socket.data.closed ? new Set() : new Set([socket]);
      await renderer.suspend();
    }
    clients.delete(socket);
    if (lastTyped === socket) lastTyped = undefined;
    if (goodbye) say(socket, goodbye);
    output.targets = new Set(clients);
    if (renderer && !renderer.isDestroyed && clients.size > 0) await renderer.resume();
    clientsChanged();
  };

  const quit = async () => {
    if (quitting) return;
    quitting = true;
    mux?.shutdown();
    output.targets = new Set(clients);
    if (renderer && !renderer.isDestroyed) {
      renderer.destroy();
      await renderer.closed;
    }
    for (const client of clients) say(client, { reason: "exited", message: `Session ${name} ended` });
    control.stop();
    listener.stop(true);
    rmSync(paths.client, { force: true });
    setTimeout(() => process.exit(0), 200);
  };

  const control = serveControl(paths.control, (request) => {
    switch (request.method) {
      case "session.info":
        return { ok: true, result: { session: name, ...(mux?.counts() ?? { tabs: 0, panes: 0 }), attached: clients.size } };
      case "session.quit":
        if (mux) return mux.handleControl(request);
        serialize(quit);
        return { ok: true };
      default:
        if (!mux) return { ok: false, error: `nobody has attached to session ${name} yet` };
        return mux.handleControl(request);
    }
  });

  const listener = Bun.listen<Client>({
    unix: paths.client,
    socket: {
      open(socket) {
        socket.data = { decoder: new FrameDecoder(), writer: new SocketWriter(socket), size: undefined, closed: false };
      },
      data(socket, chunk) {
        let frames: Frame[];
        try {
          frames = socket.data.decoder.push(chunk);
        } catch (error) {
          say(socket, { reason: "error", message: (error as Error).message });
          return;
        }
        for (const frame of frames) {
          switch (frame.type) {
            case "hello":
              serialize(() => attach(socket, frame.body));
              break;
            case "input":
              if (clients.has(socket)) {
                lastTyped = socket;
                input.push(Buffer.from(frame.body));
              }
              break;
            case "resize":
              socket.data.size = frame.body;
              if (clients.has(socket)) serialize(async () => applySize());
              break;
          }
        }
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        socket.data.closed = true;
        serialize(() => release(socket, undefined));
      },
    },
  });

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => serialize(quit));
}

async function claimSockets(name: string, paths: SessionPaths): Promise<void> {
  if (!tryLock(paths.lock)) throw new SessionError(`session ${name} is already running`);
  rmSync(paths.client, { force: true });
  rmSync(paths.control, { force: true });
}
