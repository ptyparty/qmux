import { describe, expect, test } from "bun:test";
import { isQuit, matchCommands, parseCommands } from "./commands.ts";

const commands = [
  { name: "compact", description: "Compact the conversation" },
  { name: "context", description: "Show context usage" },
  { name: "code-review", description: "Review the diff", argumentHint: "<level>" },
  { name: "model", description: "Pick a model" },
];

describe("slash command completion", () => {
  test("matches names that start with what was typed, then ones that contain it", () => {
    expect(matchCommands(commands, "/co").map((command) => command.name)).toEqual(["compact", "context", "code-review"]);
    expect(matchCommands(commands, "/view").map((command) => command.name)).toEqual(["code-review"]);
    expect(matchCommands(commands, "/").map((command) => command.name)).toEqual(["exit", "quit", "compact", "context", "code-review", "model"]);
  });

  test("only completes the command word, and only for slash input", () => {
    expect(matchCommands(commands, "/code-review high")).toEqual([]);
    expect(matchCommands(commands, "co")).toEqual([]);
    expect(matchCommands(commands, "/co", 1)).toHaveLength(1);
  });

  test("an exact name comes first, and Claude's own exit or quit isn't listed twice", () => {
    const claude = [{ name: "context-usage", description: "" }, { name: "context", description: "" }, { name: "exit", description: "" }];
    expect(matchCommands(claude, "/context").map((command) => command.name)).toEqual(["context", "context-usage"]);
    expect(matchCommands(claude, "/ex").map((command) => command.name)).toEqual(["exit", "context-usage", "context"]);
  });

  test("commands from Claude are checked and their descriptions made one line", () => {
    expect(parseCommands([{ name: "a", description: "one\n  two" }, { name: "" }, { description: "x" }, { name: "b", argumentHint: "<n>" }, "c"])).toEqual([
      { name: "a", description: "one two", argumentHint: undefined },
      { name: "b", description: "", argumentHint: "<n>" },
    ]);
    expect(parseCommands(undefined)).toEqual([]);
  });

  test("/exit and /quit quit, in any case", () => {
    expect([isQuit("/exit"), isQuit("/Quit "), isQuit("/exits")]).toEqual([true, true, false]);
  });
});
