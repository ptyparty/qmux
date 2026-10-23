import { describe, expect, test } from "bun:test";
import { wordAt } from "./words.ts";

function word(line: string, column: number): string | undefined {
  const bounds = wordAt(line, column);
  return bounds && line.slice(bounds.start, bounds.end);
}

describe("wordAt", () => {
  test("selects the run of non-space characters under the cursor", () => {
    expect(word("hello world", 7)).toBe("world");
    expect(word("cd ~/work/stories/qmux now", 8)).toBe("~/work/stories/qmux");
    expect(word("see https://example.com/a?b=c done", 10)).toBe("https://example.com/a?b=c");
  });

  test("trims surrounding quotes, brackets and trailing punctuation", () => {
    expect(word('open "src/cli.ts" please', 8)).toBe("src/cli.ts");
    expect(word("(see src/mux/pane.ts:42).", 6)).toBe("src/mux/pane.ts:42");
    expect(word("done.", 1)).toBe("done");
  });

  test("nothing on whitespace or past the end", () => {
    expect(wordAt("a b", 1)).toBeUndefined();
    expect(wordAt("abc", 5)).toBeUndefined();
  });
});
