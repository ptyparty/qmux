import { describe, expect, test } from "bun:test";
import { configSchema } from "./config.ts";
import { formatClock, Tray, trayWidgets, type TrayWidget } from "./tray.ts";

async function settle(tray: Tray, check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Bun.sleep(10);
  tray.stop();
}

describe("tray", () => {
  test("formats the clock with day names and a 24 hour time", () => {
    const date = new Date(2026, 9, 25, 14, 5, 9);
    expect(formatClock(date, "ddd HH:mm")).toBe("Sun 14:05");
    expect(formatClock(date, "dddd D MMM YYYY HH:mm:ss")).toBe("Sunday 25 Oct 2026 14:05:09");
    expect(formatClock(date, "YYYY-MM-DD")).toBe("2026-10-25");
  });

  test("shows a system widget and a clock unless configured otherwise", () => {
    const config = configSchema.parse({});
    expect(trayWidgets(config.tray).map((widget) => widget.name)).toEqual(["system", "clock"]);
    expect(["btop", "htop", "top"]).toContain(trayWidgets(config.tray)[0]!.open![0]!);
  });

  test("accepts command widgets and widgets written in TypeScript", () => {
    const config = configSchema.parse({
      tray: [{ command: ["echo", "hi"], every: 500 }, { name: "greeting", render: () => "hello", open: ["less", "README.md"] }, { widget: "clock", format: "HH:mm" }],
    });
    const widgets = trayWidgets(config.tray);
    expect(widgets.map((widget) => [widget.name, widget.every, widget.open])).toEqual([
      ["echo", 500, undefined],
      ["greeting", 1000, ["less", "README.md"]],
      ["clock", 1000, undefined],
    ]);
  });

  test("rejects a TypeScript widget without a render function", () => {
    expect(configSchema.safeParse({ tray: [{ name: "broken", render: "nope" }] }).success).toBe(false);
  });

  test("keeps the first line of each widget's output and marks failures", async () => {
    const widgets: TrayWidget[] = [
      { name: "lines", every: 60_000, render: () => "\n first \nsecond" },
      { name: "broken", every: 60_000, render: () => Promise.reject(new Error("no")) },
      ...trayWidgets(configSchema.parse({ tray: [{ command: ["printf", "from a command\\nignored"] }] }).tray),
    ];
    let changes = 0;
    const tray = new Tray(widgets, () => changes++);
    tray.start();
    await settle(tray, () => tray.texts.every((text) => text !== ""));
    expect(tray.texts).toEqual(["first", "broken !", "from a command"]);
    expect(changes).toBe(3);
  });

  test("a failing command shows the widget as broken", async () => {
    const tray = new Tray(trayWidgets(configSchema.parse({ tray: [{ name: "nope", command: ["false"] }] }).tray), () => {});
    tray.start();
    await settle(tray, () => tray.texts[0] !== "");
    expect(tray.texts).toEqual(["nope !"]);
  });
});
