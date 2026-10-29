import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { theme } from "./theme.ts";
import type { Job } from "./workspace.ts";

export class JobsPanel {
  private readonly box: BoxRenderable;
  private readonly rows: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "20%",
      top: "15%",
      width: "60%",
      zIndex: 200,
      visible: false,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.modes.jobs,
      titleColor: theme.modes.jobs,
      backgroundColor: theme.surface,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      title: " Jobs ",
    });
    this.rows = new TextRenderable(renderer, { wrapMode: "none" });
    this.box.add(this.rows);
    renderer.root.add(this.box);
  }

  render(jobs: Job[] | undefined, selected: number, now: number): void {
    this.box.visible = jobs !== undefined;
    if (!jobs) return;
    this.rows.content = styled(jobs.length > 0 ? jobLines(jobs, selected, now) : [fg(theme.muted)("No jobs in this tab · n runs one")]);
    this.box.height = Math.max(jobs.length, 1) + 2;
  }
}

function jobLines(jobs: Job[], selected: number, now: number): Part[] {
  return jobs.flatMap((job, index) => {
    const name = ` ${jobBadge(job)} ${job.name} `;
    return [
      ...(index > 0 ? ["\n"] : []),
      index === Math.min(selected, jobs.length - 1) ? bold(fg(theme.background)(bg(theme.modes.jobs)(name))) : fg(theme.text)(name),
      fg(theme.muted)(`  ${jobDetail(job, now)}`),
    ];
  });
}

export function jobBadge(job: Job): string {
  return job.state === "running" ? "⏳" : job.state === "succeeded" ? "🎉" : "💥";
}

export function jobDetail(job: Job, now: number): string {
  const seconds = `${Math.round(((job.finished ?? now) - job.started) / 1000)}s`;
  if (job.state === "running") return `running ${seconds}`;
  return job.code === null || job.code === undefined ? `exited · ${seconds}` : `exit ${job.code} · ${seconds}`;
}
