import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { ClaudeSession } from "./session.ts";
import { Transcript } from "./transcript.ts";
import { ClaudeView } from "./view.ts";

let setup: TestRendererSetup | undefined;
let view: ClaudeView | undefined;

afterEach(async () => {
  view?.destroy();
  await setup?.dispose();
  setup = undefined;
  view = undefined;
});

async function open() {
  setup = await createTestRenderer({ width: 80, height: 20 });
  const sent: string[] = [];
  const interrupts: number[] = [];
  const session = {
    transcript: new Transcript(),
    commands: [
      { name: "compact", description: "Free up context" },
      { name: "context", description: "Show context usage" },
    ],
    send: (text: string) => sent.push(text),
    interrupt: () => interrupts.push(1),
  };
  let quit = false;
  view = new ClaudeView(setup.renderer, session as unknown as ClaudeSession, () => (quit = true));
  view.render();
  await setup.renderOnce();
  return { setup, session, sent, interrupts, quitted: () => quit };
}

async function frame(setup: TestRendererSetup): Promise<string> {
  await Bun.sleep(80);
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("native Claude slash completion", () => {
  test("typing / lists commands; arrows pick, Enter runs the pick, Tab completes for arguments", async () => {
    const { setup, sent } = await open();
    await setup.mockInput.typeText("/co");
    expect(await frame(setup)).toContain("/compact  Free up context");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await frame(setup);
    expect(sent).toEqual(["/context"]);
    await setup.mockInput.typeText("/comp");
    setup.mockInput.pressTab();
    expect(await frame(setup)).toContain("/compact ");
    expect(sent).toEqual(["/context"]);
  });

  test("Esc hides the list, but still interrupts a working Claude", async () => {
    const { setup, session, interrupts } = await open();
    await setup.mockInput.typeText("/co");
    expect(await frame(setup)).toContain("Show context usage");
    setup.mockInput.pressEscape();
    expect(await frame(setup)).not.toContain("Show context usage");
    expect(interrupts).toEqual([]);
    session.transcript.state = "working";
    await setup.mockInput.typeText("m");
    setup.mockInput.pressEscape();
    await frame(setup);
    expect(interrupts).toEqual([1]);
  });

  test("/exit quits instead of going to Claude", async () => {
    const { setup, sent, quitted } = await open();
    await setup.mockInput.typeText("/exit");
    setup.mockInput.pressEscape();
    await frame(setup);
    setup.mockInput.pressEnter();
    await frame(setup);
    expect(quitted()).toBe(true);
    expect(sent).toEqual([]);
  });
});
