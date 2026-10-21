import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, ProtocolError, type Frame } from "./protocol.ts";

const frames: Frame[] = [
  { type: "hello", body: { cols: 120, rows: 40, env: { TERM: "xterm-ghostty" } } },
  { type: "input", body: new TextEncoder().encode("ls\r") },
  { type: "resize", body: { cols: 80, rows: 24 } },
  { type: "output", body: new Uint8Array([0x1b, 0x5b, 0x48, 0xe4, 0xb8, 0x80]) },
  { type: "goodbye", body: { reason: "detached", message: "Detached from main" } },
];

describe("session protocol", () => {
  test("frames round-trip", () => {
    const decoder = new FrameDecoder();
    const bytes = frames.map(encodeFrame);
    expect(decoder.push(Buffer.concat(bytes))).toEqual(frames);
  });

  test("frames split across chunks are reassembled", () => {
    const decoder = new FrameDecoder();
    const bytes = Buffer.concat(frames.map(encodeFrame));
    const decoded: Frame[] = [];
    for (let i = 0; i < bytes.length; i += 3) decoded.push(...decoder.push(bytes.subarray(i, i + 3)));
    expect(decoded).toEqual(frames);
  });

  test("unknown frame types are rejected", () => {
    expect(() => new FrameDecoder().push(new Uint8Array([9, 0, 0, 0, 0]))).toThrow(ProtocolError);
  });
});
