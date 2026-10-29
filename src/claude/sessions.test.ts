import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { age, describe as describeSession, pastSessions, pickerItems, projectDir } from "./sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "qmux-sessions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (entry: object) => `${JSON.stringify(entry)}\n`;

describe("Claude sessions", () => {
  test("a directory maps to Claude's project folder", () => {
    expect(projectDir("/home/me/work/stories/sc-1", "/cfg")).toBe("/cfg/projects/-home-me-work-stories-sc-1");
  });

  test("a session is described by its newest title, a rename winning, and its last prompt", () => {
    const text = [
      'tle","aiTitle":"cut off"}\n',
      line({ type: "ai-title", aiTitle: "First guess" }),
      line({ type: "last-prompt", lastPrompt: "fix the build" }),
      line({ type: "ai-title", aiTitle: "Fix the build" }),
    ].join("");
    expect(describeSession(text)).toEqual({ title: "Fix the build", lastPrompt: "fix the build" });
    expect(describeSession(text + line({ type: "custom-title", customTitle: "Build" })).title).toBe("Build");
  });

  test("past sessions come newest first, up to the limit", async () => {
    writeFileSync(join(dir, "old.jsonl"), line({ type: "ai-title", aiTitle: "Old" }));
    writeFileSync(join(dir, "new.jsonl"), line({ type: "ai-title", aiTitle: "New" }));
    writeFileSync(join(dir, "notes.txt"), "");
    utimesSync(join(dir, "old.jsonl"), 1000, 1000);
    expect((await pastSessions(dir, 5)).map((session) => session.title)).toEqual(["New", "Old"]);
    expect(await pastSessions(dir, 1)).toHaveLength(1);
  });

  test("the picker lists sessions open in qmux, then ones running elsewhere, then New, then the past", () => {
    const items = pickerItems({
      live: [
        { paneId: 4, sessionId: "a", tab: "merlin" },
        { paneId: 9, sessionId: "elsewhere", tab: "other" },
      ],
      running: [
        { sessionId: "a", kind: "interactive" },
        { sessionId: "b", name: "named", kind: "interactive" },
      ],
      past: [
        { sessionId: "a", title: "Alpha", modified: 0 },
        { sessionId: "c", title: "Gamma", lastPrompt: "hi\n  there", modified: 7_200_000 },
      ],
      known: ["a", "b", "c"],
      now: 3 * 3_600_000,
    });
    expect(items.map((item) => [item.label, item.detail, item.choice])).toEqual([
      ["Alpha", "open in merlin · go there", { kind: "focus", paneId: 4, sessionId: "a" }],
      ["named", "running in another terminal · open here too", { kind: "resume", sessionId: "b" }],
      ["New conversation", "start fresh", { kind: "new" }],
      ["Gamma", "1h ago · › hi there", { kind: "resume", sessionId: "c" }],
    ]);
  });

  test("ages read in the largest whole unit", () => {
    expect([age(30_000), age(5 * 60_000), age(3 * 3_600_000), age(50 * 3_600_000)]).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
  });

  test("as a job, the picker offers not to start Claude, right after New", () => {
    const items = pickerItems({ live: [], running: [], past: [], known: [], now: 0, asJob: true });
    expect(items.map((item) => [item.label, item.choice])).toEqual([
      ["New conversation", { kind: "new" }],
      ["Don't start Claude", { kind: "skip" }],
    ]);
  });
});
