import { describe, expect, test } from "bun:test";
import { LineTail } from "./tail.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LineTail", () => {
  test("keeps the last line with text, without colours, including one still being written", () => {
    const tail = new LineTail();
    expect(tail.push(bytes("\x1b[32mstarting\x1b[0m\nlisten"))).toBe(true);
    expect(tail.line).toBe("listen");
    tail.push(bytes("ing on :3000\n\n   \n"));
    expect(tail.line).toBe("listening on :3000");
    expect(tail.push(bytes(""))).toBe(false);
  });

  test("a colour code split across reads is still removed, and an endless progress line stays small", () => {
    const tail = new LineTail();
    tail.push(bytes("\x1b[3"));
    tail.push(bytes("2mlistening\x1b[0m\n"));
    expect(tail.line).toBe("listening");
    for (let step = 0; step < 5000; step++) tail.push(bytes(`\rstep ${step}`));
    expect(tail.line).toBe("step 4999");
    tail.push(bytes("x".repeat(10_000)));
    expect(tail.line.length).toBeLessThanOrEqual(4096);
  });

  test("a progress line rewritten with carriage returns shows its newest state", () => {
    const tail = new LineTail();
    tail.push(bytes("build 10%\rbuild 55%"));
    expect(tail.line).toBe("build 55%");
    tail.push(bytes("\rbuild 100%\r\n"));
    expect(tail.line).toBe("build 100%");
  });
});
