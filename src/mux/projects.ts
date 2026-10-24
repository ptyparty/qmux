import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export type Project = { name: string; dir: string; layout?: string };

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function findProjects(roots: string[]): Project[] {
  const projects = new Map<string, Project>();
  for (const root of roots) {
    const pattern = expandHome(root);
    const base = isAbsolute(pattern) ? "/" : process.cwd();
    for (const match of new Bun.Glob(pattern.replace(/^\//, "")).scanSync({ cwd: base, onlyFiles: false, absolute: true })) {
      if (isDirectory(match) && !projects.has(match)) projects.set(match, { name: basename(match), dir: match });
    }
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

export function looksLikePath(target: string): boolean {
  return target.includes("/") || target.startsWith("~") || target === "." || target === "..";
}

export function resolveTarget(target: string, cwd: string, projects: Project[]): Project | undefined {
  if (looksLikePath(target)) {
    const dir = resolve(cwd, expandHome(target));
    return isDirectory(dir) ? { name: basename(dir), dir } : undefined;
  }
  return rankProjects(target, projects)[0];
}

export function rankProjects(query: string, projects: Project[]): Project[] {
  const needle = query.toLowerCase();
  if (needle === "") return projects;
  const scored = projects.flatMap((project) => {
    const score = matchScore(needle, project.name.toLowerCase());
    return score === undefined ? [] : [{ project, score }];
  });
  return scored.sort((a, b) => a.score - b.score || a.project.name.length - b.project.name.length).map(({ project }) => project);
}

function matchScore(needle: string, name: string): number | undefined {
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  let position = 0;
  for (const char of needle) {
    position = name.indexOf(char, position);
    if (position < 0) return undefined;
    position++;
  }
  return 3;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
