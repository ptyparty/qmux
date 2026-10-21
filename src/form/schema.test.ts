import { describe, expect, test } from "bun:test";
import { formSpec } from "./schema.ts";

function issues(input: unknown): string[] {
  const result = formSpec.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("form spec", () => {
  test("accepts a form using every element type", () => {
    expect(
      issues({
        title: "Deploy",
        elements: [
          { type: "note", text: "Pick carefully" },
          { type: "confirm", id: "deploy", label: "Deploy now?", default: true },
          { type: "choice", id: "env", label: "Where?", options: ["dev", { value: "prod", description: "careful" }], default: "dev", when: "deploy" },
          { type: "choice", id: "checks", label: "Checks", options: ["lint", "test"], multi: true, default: ["test"] },
          { type: "number", id: "replicas", label: "Replicas", min: 1, max: 9, step: 2, default: 3 },
          { type: "text", id: "notes", label: "Notes", multiline: true, when: 'selected(env, "prod")' },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects duplicate ids", () => {
    expect(
      issues({
        title: "x",
        elements: [
          { type: "text", id: "a", label: "A" },
          { type: "confirm", id: "a", label: "A again" },
        ],
      }),
    ).toEqual(["elements.1.id: duplicate id a"]);
  });

  test("when may only reference earlier elements", () => {
    expect(
      issues({
        title: "x",
        elements: [
          { type: "text", id: "a", label: "A", when: "b" },
          { type: "text", id: "b", label: "B", when: "a &&" },
        ],
      }),
    ).toEqual(["elements.0.when: b is not an earlier element", "elements.1.when: invalid expression: unexpected end of expression"]);
  });

  test("choice defaults must be options of the right shape", () => {
    expect(
      issues({
        title: "x",
        elements: [
          { type: "choice", id: "a", label: "A", options: ["x"], default: ["x"] },
          { type: "choice", id: "b", label: "B", options: ["x", "x"], multi: true, default: ["y"] },
        ],
      }),
    ).toEqual([
      "elements.0.default: single choice default must be a string",
      "elements.1.options: option values must be unique",
      "elements.1.default: y is not an option",
    ]);
  });

  test("number default must be in range", () => {
    expect(issues({ title: "x", elements: [{ type: "number", id: "n", label: "N", min: 5, max: 1, default: 9 }] })).toEqual([
      "elements.0.max: max must be at least min",
      "elements.0.default: default must be between min and max",
    ]);
  });

  test("ids must be identifiers", () => {
    expect(issues({ title: "x", elements: [{ type: "text", id: "has space", label: "A" }] })).toHaveLength(1);
    expect(issues({ title: "x", elements: [{ type: "text", id: "true", label: "A" }] })).toHaveLength(1);
  });
});
