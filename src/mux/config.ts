import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { leaf, type LayoutNode, type PaneId } from "./layout.ts";

export type PaneSpec = { command?: string[]; name?: string; focus?: boolean; size?: number };
export type SplitSpec = { row: LayoutSpec[]; size?: number } | { column: LayoutSpec[]; size?: number };
export type LayoutSpec = PaneSpec | SplitSpec;

const size = z.number().positive().optional().describe("Share of the parent split, relative to its siblings (default 1)");

const paneSpec = z
  .object({
    command: z.array(z.string()).min(1).optional().describe("Program and arguments; defaults to $SHELL"),
    name: z.string().optional(),
    focus: z.boolean().optional(),
    size,
  })
  .strict();

const layoutSpec: z.ZodType<LayoutSpec> = z.lazy(() =>
  z.union([
    z.object({ row: z.array(layoutSpec).min(1), size }).strict(),
    z.object({ column: z.array(layoutSpec).min(1), size }).strict(),
    paneSpec,
  ]),
);

export const configSchema = z
  .object({
    defaultCwd: z.string().optional().describe("Directory for new tabs; defaults to the focused pane's directory"),
    layouts: z.record(z.string(), layoutSpec).default({}),
    projects: z
      .object({
        roots: z.array(z.string()).default(["~/work/*/*"]),
        layout: z.string().optional().describe("Layout for tabs opened with Ctrl+t o or qmux project"),
      })
      .default({ roots: ["~/work/*/*"] }),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.projects.layout && !(config.projects.layout in config.layouts)) {
      ctx.addIssue({ code: "custom", path: ["projects", "layout"], message: `no layout named ${config.projects.layout}` });
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

export function planLayout(spec: LayoutSpec, allocate: () => PaneId): { root: LayoutNode; panes: PlannedPane[]; focus: PaneId } {
  const panes: PlannedPane[] = [];
  let focus: PaneId | undefined;
  const build = (node: LayoutSpec): LayoutNode => {
    if ("row" in node || "column" in node) {
      const axis = "row" in node ? "row" : "column";
      const children = "row" in node ? node.row : node.column;
      const total = children.reduce((sum, child) => sum + (child.size ?? 1), 0);
      return { kind: "split", axis, children: children.map((child) => ({ node: build(child), weight: (child.size ?? 1) / total })) };
    }
    const id = allocate();
    panes.push({ id, command: node.command, name: node.name });
    if (node.focus && focus === undefined) focus = id;
    return leaf(id);
  };
  const root = build(spec);
  return { root, panes, focus: focus ?? panes[0]!.id };
}
