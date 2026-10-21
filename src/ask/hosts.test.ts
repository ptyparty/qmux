import { describe, expect, test } from "bun:test";
import { resolveHost, shellQuote, tmuxArgs, zellijArgs } from "./hosts.ts";

describe("hosts", () => {
  test("auto picks the multiplexer the caller runs in", () => {
    expect(resolveHost("auto", { QMUX_SOCKET: "/run/qmux.sock" })).toBe("qmux");
    expect(resolveHost("auto", { QMUX_SOCKET: "/run/qmux.sock", TMUX: "/tmp/tmux-1/default,1,0" })).toBe("tmux");
    expect(resolveHost("auto", { ZELLIJ: "0" })).toBe("zellij");
    expect(resolveHost("auto", { TMUX: "/tmp/tmux-1/default,1,0" })).toBe("tmux");
    expect(resolveHost("auto", {})).toBe("none");
    expect(resolveHost("tmux", { ZELLIJ: "0" })).toBe("tmux");
  });

  test("zellij opens a pinned floating pane that closes with the form", () => {
    expect(zellijArgs(["qmux", "form", "--ask", "x"], "Deploy")).toEqual([
      "zellij", "run",
      "--floating", "--close-on-exit", "--pinned", "true",
      "--name", "qmux: Deploy",
      "--width", "80%", "--height", "80%", "--x", "10%", "--y", "10%",
      "--", "qmux", "form", "--ask", "x",
    ]);
  });

  test("tmux receives a quoted shell command", () => {
    expect(tmuxArgs(["/opt/my bun", "form"], "T").at(-1)).toBe("'/opt/my bun' form");
  });

  test("shell quoting", () => {
    expect(shellQuote(["a", "b c", "it's", "--x=1"])).toBe(`a 'b c' 'it'\\''s' --x=1`);
  });
});
