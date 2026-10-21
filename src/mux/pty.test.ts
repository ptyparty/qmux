import { describe, expect, test } from "bun:test";
import { Pty, ReadScheduler } from "./pty.ts";

describe("Pty", () => {
  test("writing to a program that is not reading does not block", async () => {
    let output = "";
    const pty = new Pty({
      command: ["sh", "-c", "kill -STOP $$; cat"],
      cols: 80,
      rows: 24,
      scheduler: new ReadScheduler(6, 16),
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
    });
    await Bun.sleep(200);
    const started = performance.now();
    pty.write("x".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(100);
    pty.child.kill("SIGCONT");
    await Bun.sleep(300);
    expect(output.length).toBeGreaterThan(0);
    pty.kill();
  });

  test("echoes input and reports exit", async () => {
    let output = "";
    let exited = false;
    const pty = new Pty({
      command: ["sh", "-c", "read line; echo got:$line"],
      cols: 80,
      rows: 24,
      scheduler: new ReadScheduler(6, 16),
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
      onExit: () => {
        exited = true;
      },
    });
    pty.write("hello\r");
    for (let i = 0; i < 100 && !exited; i++) await Bun.sleep(20);
    expect(output).toContain("got:hello");
    expect(exited).toBe(true);
  });
});
