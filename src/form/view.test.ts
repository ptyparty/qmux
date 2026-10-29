import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { FormController, type FormResult } from "./controller.ts";
import { type ImageOutput } from "./image.ts";
import { tinyPng } from "./test-images.ts";
import { parseFormSpec } from "./schema.ts";
import { runForm } from "./view.ts";

let setup: TestRendererSetup | undefined;

afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

async function open(elements: unknown[], images: ImageOutput = { enabled: false, write: () => {} }): Promise<{ setup: TestRendererSetup; result: Promise<FormResult> }> {
  setup = await createTestRenderer({ width: 60, height: 24 });
  const controller = new FormController(parseFormSpec({ title: "Deploy", description: "Ship it?", elements }));
  const result = runForm(setup.renderer, controller, images);
  await setup.renderOnce();
  return { setup, result };
}

async function renderedWith(setup: TestRendererSetup, text: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
    await Bun.sleep(20);
  }
  return setup.captureCharFrame();
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
    expect(frame).toMatch(/○ prod\s*│\n│\s+careful/);
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

  test("markdown renders formatted and long forms scroll by page", async () => {
    const { setup } = await open([
      { type: "markdown", text: `# Plan\n\n- **first** step\n- second step\n\n${Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n\n")}` },
      { type: "confirm", id: "ok", label: "OK?" },
    ]);
    const frame = await renderedWith(setup, "first step");
    expect(frame).toContain("Plan");
    expect(frame).not.toContain("# Plan");
    expect(frame).not.toContain("**first**");
    expect(frame).toContain("first step");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("PgUp/PgDn scroll");
    setup.mockInput.pressKey("pagedown");
    setup.mockInput.pressKey("pagedown");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("first step");
  });

  test("the mouse wheel scrolls long forms", async () => {
    const { setup } = await open([
      { type: "markdown", text: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n") },
      { type: "confirm", id: "ok", label: "OK?" },
    ]);
    await renderedWith(setup, "Line 0");
    for (let tick = 0; tick < 10; tick++) await setup.mockMouse.scroll(10, 10, "down");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toMatch(/Line 0\s/);
  });

  test("escape cancels", async () => {
    const { setup, result } = await open([{ type: "text", id: "name", label: "Name" }]);
    setup.mockInput.pressEscape();
    expect(await result).toEqual({ status: "cancelled" });
  });

  test("shows an image's caption and path when the terminal cannot draw it", async () => {
    const { setup } = await open([{ type: "image", path: "/tmp/shot.png", caption: "The broken page" }]);
    expect(await renderedWith(setup, "[image]")).toContain("[image] The broken page · /tmp/shot.png");
  });

  test("uploads an image and fills its box with placeholders", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/qmux-view-test-${process.pid}.png`;
    await Bun.write(path, tinyPng(40, 20));
    const written: string[] = [];
    const { setup } = await open([{ type: "image", path, caption: "Tiny" }], { enabled: true, write: (commands) => written.push(...commands) });
    const frame = await renderedWith(setup, "Tiny");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\x1b_Ga=T,U=1,i=\d+,c=4,r=1,f=100,q=2,m=0;/);
    expect(frame).toContain("\u{10EEEE}");
  });

  test("shows one slide at a time and sends each image once", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/qmux-slides-test-${process.pid}.png`;
    await Bun.write(path, tinyPng(40, 20));
    const written: string[] = [];
    const { setup, result } = await open(
      [{ type: "slides", id: "shots", label: "Screens", slides: [{ path, caption: "Login" }, { path, caption: "Home" }] }],
      { enabled: true, write: (commands) => written.push(...commands) },
    );
    expect(await renderedWith(setup, "1/2")).toContain("1/2 · Login");
    expect(written).toHaveLength(1);
    setup.mockInput.pressArrow("right");
    expect(await renderedWith(setup, "2/2")).toContain("2/2 · Home");
    setup.mockInput.pressArrow("left");
    expect(await renderedWith(setup, "1/2")).toContain("1/2 · Login");
    expect(written).toHaveLength(2);
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("blurry");
    setup.mockInput.pressKey("s", { ctrl: true });
    expect(await result).toEqual({ status: "submitted", values: { shots: ["blurry", ""] } });
  });

  test("says when an image cannot be read", async () => {
    const { setup } = await open([{ type: "image", path: "/nonexistent/shot.png" }], { enabled: true, write: () => {} });
    const frame = await renderedWith(setup, "Could not show");
    expect(frame).toContain("Could not show /nonexistent/shot.png");
    expect(frame).not.toContain("[image]");
  });
});
