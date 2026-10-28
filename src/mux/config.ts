import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { leaf, type LayoutNode, type PaneId } from "./layout.ts";
import { expandHome, type Project } from "./projects.ts";
import { defaultTray, trayEntry } from "./tray.ts";

export type PaneSpec = { command?: string[]; name?: string; focus?: boolean };
export type SplitSpec = { row: LayoutSpec[] } | { column: LayoutSpec[] };
export type TabsSpec = { tabs: PaneSpec[] };
export type LayoutSpec = PaneSpec | SplitSpec | TabsSpec;
export type ServiceSpec = { command: string[]; name?: string };
export type LayoutEntry = { services: ServiceSpec[]; layout: LayoutSpec };

const paneSpec = z
  .object({
    command: z.array(z.string()).min(1).optional().describe("Program and arguments; defaults to $SHELL"),
    name: z.string().optional(),
    focus: z.boolean().optional(),
  })
  .strict();

const layoutSpec: z.ZodType<LayoutSpec> = z.lazy(() =>
  z.union([
    z.object({ row: z.array(layoutSpec).min(1) }).strict(),
    z.object({ column: z.array(layoutSpec).min(1) }).strict(),
    z.object({ tabs: z.array(paneSpec).min(1) }).strict(),
    paneSpec,
  ]),
);

const serviceSpec = z
  .object({
    command: z.array(z.string()).min(1).describe("Program and arguments"),
    name: z.string().regex(/^[\w.-]+$/, "service names use letters, digits, \".\", \"_\", and \"-\"").optional(),
  })
  .strict();

const layoutEntry: z.ZodType<LayoutEntry, unknown> = z
  .looseObject({ services: z.array(serviceSpec).default([]).describe("Background processes started with the tab and stopped when it closes") })
  .transform(({ services, ...layout }) => ({ services, layout: layout as unknown }))
  .pipe(z.object({ services: z.array(serviceSpec), layout: layoutSpec }));

export const configSchema = z
  .object({
    defaultCwd: z.string().optional().describe("Directory for new tabs; defaults to the focused pane's directory"),
    env: z.record(z.string(), z.string()).default({}).describe("Environment variables set in every pane, such as EDITOR"),
    scrollback: z.number().positive().max(4000).default(50).describe("Megabytes of history each pane keeps; 50 is roughly 70,000 lines at 80 columns"),
    untrackedCommands: z.array(z.string()).default([]).describe("Programs that never get a long-running command badge, such as editors and agents"),
    layouts: z.record(z.string(), layoutEntry).default({}),
    tabs: z
      .record(z.string(), z.object({ layout: z.string(), cwd: z.string().optional().describe("Working directory; defaults to defaultCwd") }).strict())
      .default({})
      .describe("Named tabs, opened from Ctrl+t o or qmux project like projects"),
    tray: z.array(trayEntry).default(defaultTray).describe("Widgets on the right of the mode bar, such as { widget: \"clock\" }, { widget: \"system\" }, or { command: [...] }"),
    startup: z.array(z.string()).default([]).describe("Named tabs a new session opens instead of a plain tab"),
    projects: z
      .object({
        roots: z.array(z.string()).default(["~/work/*/*"]),
        layout: z.string().optional().describe("Layout for tabs opened with Ctrl+t o or qmux project"),
        layoutFor: z.record(z.string(), z.string()).default({}).describe("Layouts for particular projects, by project name"),
      })
      .default({ roots: ["~/work/*/*"], layoutFor: {} }),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.projects.layout && !(config.projects.layout in config.layouts)) {
      ctx.addIssue({ code: "custom", path: ["projects", "layout"], message: `no layout named ${config.projects.layout}` });
    }
    for (const [name, tab] of Object.entries(config.tabs)) {
      if (!(tab.layout in config.layouts)) ctx.addIssue({ code: "custom", path: ["tabs", name, "layout"], message: `no layout named ${tab.layout}` });
    }
    config.startup.forEach((name, index) => {
      if (!(name in config.tabs)) ctx.addIssue({ code: "custom", path: ["startup", index], message: `no tab named ${name}` });
    });
    for (const [project, layout] of Object.entries(config.projects.layoutFor)) {
      if (!(layout in config.layouts)) ctx.addIssue({ code: "custom", path: ["projects", "layoutFor", project], message: `no layout named ${layout}` });
    }
  });

export type Config = z.infer<typeof configSchema>;

export const defaultConfig: Config = configSchema.parse({});

export function configPath(): string {
  if (process.env.QMUX_CONFIG) return process.env.QMUX_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "qmux", "config.ts");
}

export type LoadedConfig = { config: Config; error?: string };

export async function loadConfig(path = configPath()): Promise<LoadedConfig> {
  if (!existsSync(path)) return { config: defaultConfig };
  try {
    const module = await import(`${pathToFileURL(path).href}?loaded=${Date.now()}`);
    const parsed = configSchema.safeParse(module.default);
    if (parsed.success) return { config: parsed.data };
    return { config: defaultConfig, error: `${path}: ${z.prettifyError(parsed.error).replaceAll("\n", " ")}` };
  } catch (error) {
    return { config: defaultConfig, error: `${path}: ${(error as Error).message}` };
  }
}

export type PlannedPane = { id: PaneId; command?: string[]; name?: string };

export function namedTabs(config: Config): Project[] {
  return Object.entries(config.tabs).map(([name, tab]) => ({ name, dir: expandHome(tab.cwd ?? config.defaultCwd ?? "~"), layout: tab.layout }));
}

export function projectLayout(config: Config, project: Project): LayoutEntry | undefined {
  const name = project.layout ?? config.projects.layoutFor[project.name] ?? config.projects.layout;
  return name === undefined ? undefined : config.layouts[name];
}

export function planLayout(spec: LayoutSpec, allocate: () => PaneId): { root: LayoutNode; panes: PlannedPane[]; focus: PaneId } {
  const panes: PlannedPane[] = [];
  let focus: PaneId | undefined;
  const build = (node: LayoutSpec): LayoutNode => {
    if ("tabs" in node) {
      const members = node.tabs.map(addPane);
      if (members.length === 1) return leaf(members[0]!);
      const focused = members.findIndex((id) => id === focus);
      return { kind: "tabs", panes: members, selected: Math.max(focused, 0) };
    }
    if ("row" in node || "column" in node) {
      const axis = "row" in node ? "row" : "column";
      const children = "row" in node ? node.row : node.column;
      return { kind: "split", axis, children: children.map(build) };
    }
    return leaf(addPane(node));
  };
  const addPane = (node: PaneSpec): PaneId => {
    const id = allocate();
    panes.push({ id, command: node.command, name: node.name });
    if (node.focus && focus === undefined) focus = id;
    return id;
  };
  const root = build(spec);
  return { root, panes, focus: focus ?? panes[0]!.id };
}
