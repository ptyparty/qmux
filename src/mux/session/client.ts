import type { Socket } from "bun";
import { encodeFrame, FrameDecoder, type Frame, type Goodbye } from "./protocol.ts";
import { sessionInfo, sessionPaths, SessionError, startServer } from "./sessions.ts";
import { SocketWriter } from "./socket-writer.ts";

const forwardedEnv = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LANG", "LC_ALL"];

type Connection = { decoder: FrameDecoder; writer: SocketWriter };

export async function attachSession(name: string): Promise<never> {
  if (process.env.QMUX_SESSION === name) {
    throw new SessionError(`this terminal is already inside session ${name}; attaching it to itself would hide the session`);
  }
  const paths = sessionPaths(name);
  if (!(await sessionInfo(name))) await startServer(name);
  const stdin = process.stdin;
  const stdout = process.stdout;
  let finished = false;

  const goodbye = await new Promise<Goodbye>((resolve, reject) => {
    const finish = (message: Goodbye) => {
      if (finished) return;
      finished = true;
      resolve(message);
    };
    Bun.connect<Connection>({
      unix: paths.client,
      socket: {
        open(socket) {
          socket.data = { decoder: new FrameDecoder(), writer: new SocketWriter(socket) };
          const send = (frame: Frame) => socket.data.writer.write(encodeFrame(frame));
          const env = Object.fromEntries(forwardedEnv.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
          send({ type: "hello", body: { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24, env } });
          stdin.setRawMode?.(true);
          stdin.on("data", (data: Buffer) => send({ type: "input", body: data }));
          stdin.resume();
          stdout.on("resize", () => send({ type: "resize", body: { cols: stdout.columns, rows: stdout.rows } }));
        },
        data(socket: Socket<Connection>, chunk) {
          for (const frame of socket.data.decoder.push(chunk)) {
            if (frame.type === "output") stdout.write(frame.body);
            if (frame.type === "goodbye") finish(frame.body);
          }
        },
        drain(socket: Socket<Connection>) {
          socket.data.writer.flush();
        },
        close() {
          finish({ reason: "error", message: `Lost the connection to session ${name}` });
        },
      },
    }).catch((error: Error) => reject(new SessionError(`could not connect to session ${name}: ${error.message}`)));
  });

  stdin.setRawMode?.(false);
  stdin.pause();
  stdout.write(`[${goodbye.message}]\n`);
  process.exit(goodbye.reason === "error" ? 1 : 0);
}
