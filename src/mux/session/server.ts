import { createCliRenderer, type CliRenderer } from "@opentui/core";
import type { Socket } from "bun";
import { rmSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { serveControl } from "../control.ts";
import { createMux, type Mux } from "../mux.ts";
import { encodeFrame, FrameDecoder, type Frame, type Goodbye, type Hello } from "./protocol.ts";
import { sessionPaths } from "./sessions.ts";
import { SocketWriter } from "./socket-writer.ts";

type Client = { decoder: FrameDecoder; writer: SocketWriter };

class RelayOutput extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  target: ((bytes: Uint8Array) => void) | undefined;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.target?.(chunk);
    callback();
  }
}

export async function runServer(name: string): Promise<void> {
  const paths = sessionPaths(name);
  const output = new RelayOutput();
  const input = new Readable({ read() {} });
  let renderer: CliRenderer | undefined;
  let mux: Mux | undefined;
  let current: Socket<Client> | undefined;
  let queue = Promise.resolve();

  const serialize = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => console.error(error));
  };

  const send = (socket: Socket<Client>, frame: Frame) => socket.data.writer.write(encodeFrame(frame));

  const release = async (goodbye: Goodbye | undefined) => {
    const leaving = current;
    if (!leaving) return;
    if (renderer && !renderer.isDestroyed) await renderer.suspend();
    output.target = undefined;
    current = undefined;
    if (goodbye) {
      send(leaving, { type: "goodbye", body: goodbye });
      leaving.data.writer.endWhenFlushed();
    }
  };

  const attach = async (socket: Socket<Client>, hello: Hello) => {
    if (current && current !== socket) await release({ reason: "replaced", message: `Session ${name} was attached from another terminal` });
    current = socket;
    output.columns = hello.cols;
    output.rows = hello.rows;
    output.target = (bytes) => send(socket, { type: "output", body: bytes });
    if (!renderer) {
      renderer = await createCliRenderer({
        stdin: input as unknown as NodeJS.ReadStream,
        stdout: output as unknown as NodeJS.WriteStream,
        width: hello.cols,
        height: hello.rows,
        environment: hello.env,
        exitOnCtrlC: false,
        exitSignals: [],
        targetFps: 120,
        maxFps: 120,
        useMouse: true,
      });
      mux = createMux(renderer, {
        session: name,
        controlSocket: paths.control,
        onDetach: () => serialize(() => release({ reason: "detached", message: `Detached from session ${name}` })),
        onQuit: () => serialize(quit),
      });
      return;
    }
    await renderer.resume();
    renderer.resize(hello.cols, hello.rows);
  };

  const quit = async () => {
    mux?.shutdown();
    if (renderer && !renderer.isDestroyed) {
      renderer.destroy();
      await renderer.closed;
    }
    if (current) {
      send(current, { type: "goodbye", body: { reason: "exited", message: `Session ${name} ended` } });
      current.data.writer.endWhenFlushed();
    }
    control.stop();
    listener.stop(true);
    rmSync(paths.client, { force: true });
    setTimeout(() => process.exit(0), 200);
  };

  const control = serveControl(paths.control, (request) => {
    if (request.method === "session.info") {
      const result = mux?.handleControl(request);
      const counts = result?.ok ? (result.result as object) : { session: name, tabs: 0, panes: 0 };
      return { ok: true, result: { ...counts, attached: current !== undefined } };
    }
    if (!mux) return { ok: false, error: `session ${name} is still starting` };
    return mux.handleControl(request);
  });

  rmSync(paths.client, { force: true });
  const listener = Bun.listen<Client>({
    unix: paths.client,
    socket: {
      open(socket) {
        socket.data = { decoder: new FrameDecoder(), writer: new SocketWriter(socket) };
      },
      data(socket, chunk) {
        let frames: Frame[];
        try {
          frames = socket.data.decoder.push(chunk);
        } catch (error) {
          send(socket, { type: "goodbye", body: { reason: "error", message: (error as Error).message } });
          socket.data.writer.endWhenFlushed();
          return;
        }
        for (const frame of frames) {
          switch (frame.type) {
            case "hello":
              serialize(() => attach(socket, frame.body));
              break;
            case "input":
              if (socket === current) input.push(Buffer.from(frame.body));
              break;
            case "resize":
              if (socket === current && renderer) {
                output.columns = frame.body.cols;
                output.rows = frame.body.rows;
                renderer.resize(frame.body.cols, frame.body.rows);
              }
              break;
          }
        }
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        if (socket === current) serialize(() => release(undefined));
      },
    },
  });

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => serialize(quit));
}
