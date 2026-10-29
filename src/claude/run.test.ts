import { describe, expect, test } from "bun:test";
import { latestActivity } from "./run.ts";

describe("native Claude activity", () => {
  test("is the newest line being written, or the tool being run", () => {
    expect(latestActivity([])).toBeUndefined();
    expect(latestActivity([{ kind: "text", text: "Looking at the build.\n\nThe failure is in\n  ", streaming: true }])).toBe("The failure is in");
    expect(latestActivity([{ kind: "text", text: "x", streaming: false }, { kind: "tool", id: "t", name: "Bash", summary: "./scripts/up", status: "running" }])).toBe("▸ Bash  ./scripts/up");
    expect(latestActivity([{ kind: "user", text: "hi" }])).toBeUndefined();
  });
});
