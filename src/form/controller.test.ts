import { describe, expect, test } from "bun:test";
import { FormController, type FormAction, type Focusable } from "./controller.ts";
import { parseFormSpec } from "./schema.ts";

function controllerFor(elements: unknown[]): FormController {
  return new FormController(parseFormSpec({ title: "Test", elements }));
}

function run(controller: FormController, ...actions: FormAction["type"][]): void {
  for (const type of actions) controller.dispatch({ type } as FormAction);
}

function focusName(focusable: Focusable): string {
  return focusable.kind === "submit" ? "submit" : `${focusable.kind}:${focusable.element.id}`;
}

describe("FormController", () => {
  test("submits defaults", () => {
    const form = controllerFor([
      { type: "text", id: "name", label: "Name", default: "qmux" },
      { type: "confirm", id: "ok", label: "OK?", default: true },
      { type: "number", id: "n", label: "N", min: 2, max: 5 },
      { type: "choice", id: "env", label: "Env", options: ["dev", "prod"], default: "prod" },
      { type: "choice", id: "tags", label: "Tags", options: ["a", "b"], multi: true },
    ]);
    form.dispatch({ type: "submit" });
    expect(form.result).toEqual({ status: "submitted", values: { name: "qmux", ok: true, n: 2, env: "prod", tags: [] } });
  });

  test("slides page with left and right, and keep one note per slide", () => {
    const form = controllerFor([{ type: "slides", id: "shots", slides: [{ path: "a.png" }, { path: "b.png" }, { path: "c.png" }] }]);
    run(form, "left", "right", "right", "right");
    expect(form.slides("shots").index).toBe(2);
    run(form, "next");
    expect(focusName(form.focused())).toBe("note:shots");
    form.dispatch({ type: "setNote", id: "shots", value: "too dark" });
    run(form, "previous", "left");
    form.dispatch({ type: "setNote", id: "shots", value: "fine" });
    run(form, "submit");
    expect(form.result).toEqual({ status: "submitted", values: { shots: ["", "fine", "too dark"] } });
    const follow = controllerFor([
      { type: "slides", id: "shots", slides: [{ path: "a.png" }] },
      { type: "text", id: "why", label: "Why?", when: "shots" },
    ]);
    expect(follow.visibleElements().map((element) => element.type)).toEqual(["slides"]);
    follow.dispatch({ type: "setNote", id: "shots", value: "blurry" });
    expect(follow.visibleElements().map((element) => element.type)).toEqual(["slides", "text"]);
    const plain = controllerFor([{ type: "slides", id: "shots", slides: [{ path: "a.png" }], notes: false }]);
    run(plain, "next");
    expect(focusName(plain.focused())).toBe("submit");
    run(plain, "submit");
    expect(plain.result).toEqual({ status: "submitted", values: { shots: null } });
  });

  test("cancel", () => {
    const form = controllerFor([{ type: "text", id: "name", label: "Name" }]);
    run(form, "cancel");
    expect(form.result).toEqual({ status: "cancelled" });
  });

  test("focus moves through inputs, skipping notes, and stops at the ends", () => {
    const form = controllerFor([
      { type: "note", text: "hello" },
      { type: "text", id: "a", label: "A" },
      { type: "confirm", id: "b", label: "B" },
    ]);
    expect(focusName(form.focused())).toBe("input:a");
    run(form, "previous");
    expect(focusName(form.focused())).toBe("input:a");
    run(form, "next", "next", "next");
    expect(focusName(form.focused())).toBe("submit");
  });

  test("single choice selects as the cursor moves and leaves at the edges", () => {
    const form = controllerFor([
      { type: "choice", id: "env", label: "Env", options: ["dev", "staging", "prod"], other: false },
      { type: "confirm", id: "ok", label: "OK" },
    ]);
    expect(form.answer("env")).toBeNull();
    run(form, "down", "down");
    expect(form.answer("env")).toBe("prod");
    expect(form.choice("env").cursor).toBe(2);
    run(form, "down");
    expect(focusName(form.focused())).toBe("input:ok");
    run(form, "up");
    expect(focusName(form.focused())).toBe("input:env");
  });

  test("enter on a single choice selects the cursor row and advances", () => {
    const form = controllerFor([
      { type: "choice", id: "env", label: "Env", options: ["dev", "prod"] },
      { type: "confirm", id: "ok", label: "OK" },
    ]);
    run(form, "activate");
    expect(form.answer("env")).toBe("dev");
    expect(focusName(form.focused())).toBe("input:ok");
  });

  test("multi choice toggles with space and includes other text", () => {
    const form = controllerFor([{ type: "choice", id: "tags", label: "Tags", options: ["a", "b", "c"], multi: true }]);
    run(form, "toggle", "down", "down", "toggle", "down", "toggle");
    expect(form.answer("tags")).toEqual(["a", "c"]);
    expect(form.focusables().map(focusName)).toEqual(["input:tags", "other:tags", "submit"]);
    form.dispatch({ type: "setOtherText", id: "tags", value: "d" });
    expect(form.answer("tags")).toEqual(["a", "c", "d"]);
    run(form, "up", "up", "up", "toggle");
    expect(form.answer("tags")).toEqual(["c", "d"]);
  });

  test("single choice other uses the typed text", () => {
    const form = controllerFor([{ type: "choice", id: "env", label: "Env", options: ["dev"] }]);
    run(form, "down");
    expect(form.choice("env").otherSelected).toBe(true);
    run(form, "next");
    expect(focusName(form.focused())).toBe("other:env");
    form.dispatch({ type: "setOtherText", id: "env", value: "qa" });
    run(form, "submit");
    expect(form.result).toEqual({ status: "submitted", values: { env: "qa" } });
  });

  test("confirm and number respond to left and right", () => {
    const form = controllerFor([
      { type: "confirm", id: "ok", label: "OK" },
      { type: "number", id: "n", label: "N", min: 0, max: 10, step: 4, default: 4 },
    ]);
    run(form, "left");
    expect(form.answer("ok")).toBe(true);
    run(form, "toggle");
    expect(form.answer("ok")).toBe(false);
    run(form, "next", "right", "right");
    expect(form.answer("n")).toBe(10);
    run(form, "left", "left", "left", "left");
    expect(form.answer("n")).toBe(0);
  });

  test("fractional steps do not drift", () => {
    const form = controllerFor([{ type: "number", id: "ratio", label: "Ratio", min: 0, max: 1, step: 0.1 }]);
    run(form, "right", "right", "right");
    expect(form.answer("ratio")).toBe(0.3);
  });

  test("hidden elements are skipped and omitted from the result", () => {
    const form = controllerFor([
      { type: "confirm", id: "deploy", label: "Deploy?" },
      { type: "choice", id: "env", label: "Env", options: ["dev", "prod"], default: "dev", when: "deploy" },
      { type: "text", id: "why", label: "Why prod?", when: 'selected(env, "prod")' },
    ]);
    expect(form.focusables().map(focusName)).toEqual(["input:deploy", "submit"]);
    run(form, "toggle");
    expect(form.focusables().map(focusName)).toEqual(["input:deploy", "input:env", "submit"]);
    run(form, "next", "down");
    expect(form.focusables().map(focusName)).toEqual(["input:deploy", "input:env", "input:why", "submit"]);
    run(form, "previous", "toggle", "submit");
    expect(form.result).toEqual({ status: "submitted", values: { deploy: false } });
  });

  test("focus falls back to submit when the focused element is hidden", () => {
    const form = controllerFor([
      { type: "confirm", id: "a", label: "A", default: true },
      { type: "text", id: "b", label: "B", when: "a" },
    ]);
    run(form, "next");
    expect(focusName(form.focused())).toBe("input:b");
    run(form, "previous", "toggle");
    expect(focusName(form.focused())).toBe("input:a");
  });

  test("validation errors block submit and focus the first problem", () => {
    const form = controllerFor([
      { type: "confirm", id: "ok", label: "OK" },
      { type: "text", id: "name", label: "Name", required: true },
      { type: "choice", id: "env", label: "Env", options: ["dev"], required: true, other: false },
    ]);
    run(form, "submit");
    expect(form.result).toBeNull();
    expect([...form.errors]).toEqual([
      ["name", "This field is required"],
      ["env", "Select an option"],
    ]);
    expect(focusName(form.focused())).toBe("input:name");
    form.dispatch({ type: "setText", id: "name", value: "x" });
    expect(form.errors.has("name")).toBe(false);
    run(form, "next", "activate", "submit");
    expect(form.result).toEqual({ status: "submitted", values: { ok: false, name: "x", env: "dev" } });
  });

  test("selected other requires text", () => {
    const form = controllerFor([{ type: "choice", id: "env", label: "Env", options: ["dev"] }]);
    run(form, "down", "submit");
    expect(form.errors.get("env")).toBe("Enter a value for Other");
    expect(focusName(form.focused())).toBe("input:env");
  });

  test("actions after a result are ignored", () => {
    const form = controllerFor([{ type: "confirm", id: "ok", label: "OK" }]);
    run(form, "cancel", "toggle", "submit");
    expect(form.result).toEqual({ status: "cancelled" });
  });
});
