import { describe, expect, test } from "bun:test";
import { evaluateWhen, parseWhen, referencedIds, WhenSyntaxError, type Value } from "./when.ts";

function holds(source: string, values: Record<string, Value>): boolean {
  return evaluateWhen(parseWhen(source), (id) => values[id]);
}

describe("when expressions", () => {
  test("bare ids are truthy when they have a non-empty value", () => {
    expect(holds("deploy", { deploy: true })).toBe(true);
    expect(holds("deploy", { deploy: false })).toBe(false);
    expect(holds("name", { name: "" })).toBe(false);
    expect(holds("envs", { envs: [] })).toBe(false);
    expect(holds("envs", { envs: ["prod"] })).toBe(true);
    expect(holds("missing", {})).toBe(false);
  });

  test("boolean operators follow precedence and parentheses", () => {
    expect(holds("a || b && c", { a: true, b: false, c: false })).toBe(true);
    expect(holds("(a || b) && c", { a: true, b: false, c: false })).toBe(false);
    expect(holds("!a && b", { a: false, b: true })).toBe(true);
    expect(holds("!!a", { a: "x" })).toBe(true);
    expect(holds("!deploy == false", { deploy: true })).toBe(true);
    expect(holds("!(a == 1)", { a: 2 })).toBe(true);
  });

  test("comparisons", () => {
    expect(holds('env == "prod"', { env: "prod" })).toBe(true);
    expect(holds("env != 'prod'", { env: "dev" })).toBe(true);
    expect(holds("count >= 3", { count: 3 })).toBe(true);
    expect(holds("count < 3", { count: 3 })).toBe(false);
    expect(holds("count > -1", { count: 0 })).toBe(true);
    expect(holds('name > "a"', { name: "b" })).toBe(false);
  });

  test("functions", () => {
    expect(holds('selected(envs, "prod")', { envs: ["dev", "prod"] })).toBe(true);
    expect(holds('selected(env, "prod")', { env: "prod" })).toBe(true);
    expect(holds("count(envs) == 2", { envs: ["dev", "prod"] })).toBe(true);
    expect(holds("count(name) == 1", { name: "x" })).toBe(true);
    expect(holds("empty(name)", { name: "" })).toBe(true);
  });

  test("strings support escapes", () => {
    expect(holds('name == "say \\"hi\\""', { name: 'say "hi"' })).toBe(true);
  });

  test("referenced ids", () => {
    expect(referencedIds(parseWhen('a && selected(b, "x") || c > 2'))).toEqual(["a", "b", "c"]);
  });

  test.each([
    ["a &&", "unexpected end of expression"],
    ["a b", 'unexpected ident "b"'],
    ["(a", "expected )"],
    ["nope(a)", "unknown function nope"],
    ["selected(a)", "selected takes 2 argument(s), got 1"],
    ["a # b", "unexpected character"],
    ['"open', "unterminated string"],
  ])("rejects %p", (source, message) => {
    expect(() => parseWhen(source)).toThrow(WhenSyntaxError);
    expect(() => parseWhen(source)).toThrow(message);
  });
});
