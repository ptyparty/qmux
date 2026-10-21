import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { FormController, type FormResult } from "./controller.ts";
import { parseFormSpec } from "./schema.ts";
import { runForm } from "./view.ts";

let setup: TestRendererSetup | undefined;

afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

async function open(elements: unknown[]): Promise<{ setup: TestRendererSetup; result: Promise<FormResult> }> {
  setup = await createTestRenderer({ width: 60, height: 24 });
  const controller = new FormController(parseFormSpec({ title: "Deploy", description: "Ship it?", elements }));
  const result = runForm(setup.renderer, controller);
  await setup.renderOnce();
  return { setup, result };
}

describe("form view", () => {
  test("renders every element with key hints", async () => {
    const { setup } = await open([
      { type: "note", text: "Read carefully" },
      { type: "text", id: "name", label: "Service name", placeholder: "api" },
      { type: "confirm", id: "now", label: "Deploy now?", default: true },
      { type: "number", id: "replicas", label: "Replicas", min: 1, max: 5, default: 2 },
      { type: "choice", id: "env", label: "Environment", options: ["dev", { value: "prod", description: "careful" }], default: "dev" },
    ]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Deploy");
    expect(frame).toContain("Ship it?");
    expect(frame).toContain("Read carefully");
    expect(frame).toContain("› Service name");
    expect(frame).toContain("● Yes   ○ No");
    expect(frame).toContain("◀ 2 ▶   1–5");
    expect(frame).toContain("● dev");
    expect(frame).toContain("○ prod  careful");
    expect(frame).toContain("○ Other…");
    expect(frame).toContain("[ Submit ]");
    expect(frame).toContain("Enter next");
    expect(frame).toContain("Esc");
  });

  test("typing, navigating, and submitting produces answers", async () => {
    const { setup, result } = await open([
      { type: "text", id: "name", label: "Name" },
      { type: "confirm", id: "now", label: "Now?" },
      { type: "choice", id: "env", label: "Env", options: ["dev", "prod"] },
    ]);
    await setup.mockInput.typeText("api");
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("y");
    setup.mockInput.pressTab();
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("s", { ctrl: true });
    expect(await result).toEqual({ status: "submitted", values: { name: "api", now: true, env: "prod" } });
  });

  test("other choice reveals an input that receives typing", async () => {
    const { setup, result } = await open([{ type: "choice", id: "env", label: "Env", options: ["dev"] }]);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("qa");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("qa");
    setup.mockInput.pressKey("s", { ctrl: true });
    expect(await result).toEqual({ status: "submitted", values: { env: "qa" } });
  });

  test("conditional elements appear when their condition holds", async () => {
    const { setup } = await open([
      { type: "confirm", id: "deploy", label: "Deploy?" },
      { type: "text", id: "why", label: "Why now?", when: "deploy" },
    ]);
    expect(setup.captureCharFrame()).not.toContain("Why now?");
    setup.mockInput.pressKey("y");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Why now?");
  });

  test("validation errors are shown and clear once fixed", async () => {
    const { setup } = await open([{ type: "text", id: "name", label: "Name", required: true }]);
    setup.mockInput.pressKey("s", { ctrl: true });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("This field is required");
    await setup.mockInput.typeText("x");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("This field is required");
  });

  test("arrows leave a multi-line box at its first and last lines", async () => {
    const { setup, result } = await open([
      { type: "confirm", id: "ok", label: "OK?" },
      { type: "text", id: "orders", label: "Orders", multiline: true },
      { type: "confirm", id: "after", label: "After?" },
    ]);
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("one");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("two");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Tab next field");
    setup.mockInput.pressArrow("up");
    setup.mockInput.pressArrow("up");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("› OK?");
    setup.mockInput.pressTab();
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("y");
    setup.mockInput.pressKey("s", { ctrl: true });
    expect(await result).toEqual({ status: "submitted", values: { ok: false, orders: "one\ntwo", after: true } });
  });

  test("text typed in the same burst as ctrl+s is submitted", async () => {
    const { setup, result } = await open([{ type: "text", id: "name", label: "Name" }]);
    setup.renderer.stdin.emit("data", Buffer.from("Revenge\x13"));
    expect(await result).toEqual({ status: "submitted", values: { name: "Revenge" } });
  });

  test("escape cancels", async () => {
    const { setup, result } = await open([{ type: "text", id: "name", label: "Name" }]);
    setup.mockInput.pressEscape();
    expect(await result).toEqual({ status: "cancelled" });
  });
});
