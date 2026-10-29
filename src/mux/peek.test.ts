import { describe, expect, test } from "bun:test";
import { formSpec } from "../form/schema.ts";
import { bracketedPaste, peekSpec, promptRoute } from "./peek.ts";

describe("peek", () => {
  test("shows the reply with a box to answer it", () => {
    const spec = peekSpec("Claude · merlin", "**Which** one?");
    expect(formSpec.parse(spec)).toEqual(spec);
    expect(spec.elements.map((element) => element.type)).toEqual(["markdown", "text"]);
  });

  test("native Claude always takes the answer, a Claude pane only while it isn't busy", () => {
    expect(promptRoute(true, "working")).toBe("socket");
    expect(promptRoute(false, "done")).toBe("paste");
    expect(promptRoute(false, "failed")).toBe("paste");
    expect(promptRoute(false, "working")).toBe("busy");
    expect(promptRoute(false, "waiting")).toBe("busy");
    expect(promptRoute(false, undefined)).toBe("paste");
  });

  test("a pasted answer can't end the paste early", () => {
    expect(bracketedPaste("a\x1b[201~b")).toBe("\x1b[200~ab\x1b[201~");
  });
});
