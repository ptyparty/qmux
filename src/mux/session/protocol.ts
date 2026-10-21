export type Hello = { cols: number; rows: number; env: Record<string, string> };
export type Size = { cols: number; rows: number };
export type Goodbye = { reason: "detached" | "exited" | "error"; message: string };

export type Frame =
  | { type: "hello"; body: Hello }
  | { type: "input"; body: Uint8Array }
  | { type: "resize"; body: Size }
  | { type: "output"; body: Uint8Array }
  | { type: "goodbye"; body: Goodbye };

const codes = { hello: 1, input: 2, resize: 3, output: 4, goodbye: 5 } as const;
const names = Object.fromEntries(Object.entries(codes).map(([name, code]) => [code, name])) as Record<number, Frame["type"]>;
const headerSize = 5;
const maxFrameSize = 16 * 1024 * 1024;

export class ProtocolError extends Error {}

export function encodeFrame(frame: Frame): Uint8Array {
  const body = frame.body instanceof Uint8Array ? frame.body : new TextEncoder().encode(JSON.stringify(frame.body));
  const bytes = new Uint8Array(headerSize + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, codes[frame.type]);
  view.setUint32(1, body.length);
  bytes.set(body, headerSize);
  return bytes;
}

export class FrameDecoder {
  private pending: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.pending = concat(this.pending, chunk);
    const frames: Frame[] = [];
    while (this.pending.length >= headerSize) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.length);
      const type = names[view.getUint8(0)];
      const length = view.getUint32(1);
      if (!type) throw new ProtocolError(`unknown frame type ${view.getUint8(0)}`);
      if (length > maxFrameSize) throw new ProtocolError(`frame of ${length} bytes is too large`);
      if (this.pending.length < headerSize + length) break;
      const body = this.pending.slice(headerSize, headerSize + length);
      this.pending = this.pending.slice(headerSize + length);
      frames.push(decodeBody(type, body));
    }
    return frames;
  }
}

function decodeBody(type: Frame["type"], body: Uint8Array): Frame {
  if (type === "input" || type === "output") return { type, body };
  return { type, body: JSON.parse(new TextDecoder().decode(body)) } as Frame;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}
