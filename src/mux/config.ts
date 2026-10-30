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
export type JobSpec = { command: string[]; name?: string; dock: boolean };
export type DrawerSpec = { command?: string[]; name?: string; height?: number };
export type LayoutEntry = { jobs: JobSpec[]; drawer?: DrawerSpec; args?: string[]; name?: string; layout: LayoutSpec };

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

const jobSpec = z
  .object({
    command: z.array(z.string()).min(1).describe("Program and arguments"),
    name: z.string().optional(),
    dock: z.boolean().default(false).describe("Show the job's name and last line of output at the bottom of the tab"),
  })
  .strict();

const drawerSpec = z
  .object({
    command: z.array(z.string()).min(1).optional().describe("Program and arguments; defaults to $SHELL"),
    name: z.string().optional(),
    height: z.number().int().min(20).max(80).optional().describe("Starting height as a percentage of the screen; defaults to 40"),
  })
  .strict();

const layoutEntry: z.ZodType<LayoutEntry, unknown> = z
  .looseObject({
    jobs: z.array(jobSpec).default([]).describe("Jobs started out of sight with the tab and closed with it"),
    drawer: drawerSpec.optional().describe("What Alt d opens in the tab's drawer; started the first time it opens"),
    args: z
      .array(z.string().regex(/^\w[\w-]*$/, "args are names like \"pr\"").refine((arg) => arg !== "project", "project is always filled in; pick another name"))
      .optional()
      .describe("Values qmux project --arg must give, filled in wherever {name} appears in commands and the tab name"),
    name: z.string().min(1).optional().describe("Tab name; {project} and {arg} are filled in. Defaults to the project's name"),
    services: z.undefined({ error: "services are now jobs: rename `services:` to `jobs:`" }).optional(),
  })
  .transform(({ jobs, drawer, args, name, services: _services, ...layout }) => ({
    jobs,
    ...(drawer ? { drawer } : {}),
    ...(args ? { args } : {}),
    ...(name ? { name } : {}),
    layout: layout as unknown,
  }))
  .pipe(z.object({ jobs: z.custom<JobSpec[]>(), drawer: z.custom<DrawerSpec>().optional(), args: z.custom<string[]>().optional(), name: z.string().optional(), layout: layoutSpec }));

export const configSchema = z
  .object({
    defaultCwd: z.string().optional().describe("Directory for new tabs; defaults to the focused pane's directory"),
    env: z.record(z.string(), z.string()).default({}).describe("Environment variables set in every pane, such as EDITOR"),
    scrollback: z.number().positive().max(4000).default(50).describe("Megabytes of history each pane keeps; 50 is roughly 70,000 lines at 80 columns"),
    untrackedCommands: z.array(z.string()).default([]).describe("Programs that never get a long-running command badge, such as editors and agents"),
    agentJobs: z
      .array(z.string().regex(/^[^\s.][^\s]*$/, "agentJobs are a program path like \"scripts/up\", without arguments or a leading ./"))
      .default([]).describe("Commands, such as \"scripts/up\", that agents must run in the background as jobs; foreground runs are refused"),
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
    const checkLayout = (layout: string, path: (string | number)[]) => {
      if (!(layout in config.layouts)) ctx.addIssue({ code: "custom", path, message: `no layout named ${layout}` });
      else if (config.layouts[layout]!.args?.length) ctx.addIssue({ code: "custom", path, message: `${layout} takes args, so only qmux project --layout can open it` });
    };
    if (config.projects.layout) checkLayout(config.projects.layout, ["projects", "layout"]);
    for (const [name, tab] of Object.entries(config.tabs)) checkLayout(tab.layout, ["tabs", name, "layout"]);
    config.startup.forEach((name, index) => {
      if (!(name in config.tabs)) ctx.addIssue({ code: "custom", path: ["startup", index], message: `no tab named ${name}` });
    });
    for (const [project, layout] of Object.entries(config.projects.layoutFor)) checkLayout(layout, ["projects", "layoutFor", project]);
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
  const name = layoutName(config, project);
  return name === undefined ? undefined : config.layouts[name];
}

export type ProjectTab = { name: string; layout?: LayoutEntry };

export function projectTab(config: Config, project: Project, args: Record<string, string> = {}): ProjectTab | { error: string } {
  const layoutKey = layoutName(config, project);
  const entry = layoutKey === undefined ? undefined : config.layouts[layoutKey];
  if (layoutKey !== undefined && !entry) return { error: `No layout named ${layoutKey}` };
  const declared = entry?.args ?? [];
  const missing = declared.find((arg) => !(arg in args));
  if (missing) return { error: `${layoutKey} needs --arg ${missing}=VALUE` };
  const extra = Object.keys(args).find((arg) => !declared.includes(arg));
  if (extra) return { error: layoutKey === undefined ? `${project.name} has no layout to take --arg ${extra}` : `${layoutKey} takes no ${extra} arg` };
  const values = { ...args, project: project.name };
  const fill = (text: string) => text.replace(/\{([\w-]+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? values[key as keyof typeof values]! : match));
  if (!entry) return { name: project.name };
  return { name: fill(entry.name ?? "{project}"), layout: fillLayout(entry, fill) };
}

function layoutName(config: Config, project: Project): string | undefined {
  return project.layout ?? config.projects.layoutFor[project.name] ?? config.projects.layout;
}

function fillLayout(entry: LayoutEntry, fill: (text: string) => string): LayoutEntry {
  const fillPane = <T extends { command?: string[]; name?: string }>(pane: T): T => ({ ...pane, ...(pane.command ? { command: pane.command.map(fill) } : {}), ...(pane.name ? { name: fill(pane.name) } : {}) });
  const fillSpec = (spec: LayoutSpec): LayoutSpec => {
    if ("tabs" in spec) return { tabs: spec.tabs.map(fillPane) };
    if ("row" in spec) return { row: spec.row.map(fillSpec) };
    if ("column" in spec) return { column: spec.column.map(fillSpec) };
    return fillPane(spec);
  };
  return {
    ...entry,
    jobs: entry.jobs.map((job) => ({ ...job, command: job.command.map(fill), ...(job.name ? { name: fill(job.name) } : {}) })),
    ...(entry.drawer ? { drawer: fillPane(entry.drawer) } : {}),
    layout: fillSpec(entry.layout),
  };
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
