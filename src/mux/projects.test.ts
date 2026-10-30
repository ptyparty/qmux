import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjects, findRepo, rankProjects, resolveTarget, type Project } from "./projects.ts";

const root = mkdtempSync(join(tmpdir(), "qmux-projects-"));
for (const dir of ["exfresso/penguin", "exfresso/merlin", "flipstone/orville", "stories/qmux", "stories/penguin-auth"]) {
  mkdirSync(join(root, dir), { recursive: true });
}
writeFileSync(join(root, "exfresso", "notes.txt"), "not a project");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const named = (projects: Project[]) => projects.map((project) => project.name);

describe("projects", () => {
  test("finds directories matching the roots, skipping files", () => {
    expect(named(findProjects([`${root}/*/*`]))).toEqual(["merlin", "orville", "penguin", "penguin-auth", "qmux"]);
  });

  test("ranks exact, prefix, substring, then subsequence matches", () => {
    const projects = findProjects([`${root}/*/*`]);
    expect(named(rankProjects("penguin", projects))).toEqual(["penguin", "penguin-auth"]);
    expect(named(rankProjects("pen", projects))).toEqual(["penguin", "penguin-auth"]);
    expect(named(rankProjects("auth", projects))).toEqual(["penguin-auth"]);
    expect(named(rankProjects("orvl", projects))).toEqual(["orville"]);
    expect(rankProjects("zzz", projects)).toEqual([]);
  });

  test("resolves names to projects and paths to directories", () => {
    const projects = findProjects([`${root}/*/*`]);
    expect(resolveTarget("merl", root, projects)?.dir).toBe(join(root, "exfresso/merlin"));
    expect(resolveTarget("./stories/qmux", root, projects)).toEqual({ name: "qmux", dir: join(root, "stories/qmux") });
    expect(resolveTarget("./missing", root, projects)).toBeUndefined();
  });

  test("finds a repo's clone by owner and name", () => {
    const projects = findProjects([`${root}/*/*`]);
    expect(findRepo("exfresso/penguin", projects)?.dir).toBe(join(root, "exfresso/penguin"));
    expect(findRepo("Flipstone/Orville", projects)?.dir).toBe(join(root, "flipstone/orville"));
    expect(findRepo("exfresso/penguin-auth", projects)).toBeUndefined();
  });
});
