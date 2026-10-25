import { z } from "zod";
import { busy, memoryUsed, readCpu, readMemory, systemMonitor, type CpuTimes } from "./system.ts";

export type TrayWidget = { name: string; every: number; render: () => string | Promise<string>; open?: string[] };

const openCommand = z.array(z.string()).min(1).optional().describe("Command shown in a popup when the widget is clicked or selected with Ctrl+t w");

export const trayEntry = z.union([
  z.object({ widget: z.literal("clock"), format: z.string().default("ddd HH:mm").describe("Tokens: dddd ddd YYYY MMM MM DD D HH mm ss"), open: openCommand }).strict(),
  z.object({ widget: z.literal("system"), open: openCommand.describe("Command shown in a popup when selected; defaults to btop, htop, or top, whichever is installed") }).strict(),
  z
    .object({
      name: z.string().optional(),
      command: z.array(z.string()).min(1).describe("Program whose first line of output is shown"),
      every: z.number().min(250).default(10_000).describe("Milliseconds between runs"),
      open: openCommand,
    })
    .strict(),
  z
    .object({
      name: z.string(),
      render: z.custom<() => string | Promise<string>>((value) => typeof value === "function", "render must be a function"),
      every: z.number().min(250).default(1000).describe("Milliseconds between renders"),
      open: openCommand,
    })
    .strict(),
]);

export type TrayEntry = z.infer<typeof trayEntry>;

export const defaultTray: TrayEntry[] = [{ widget: "system" }, { widget: "clock", format: "ddd HH:mm" }];

export function trayWidgets(entries: TrayEntry[]): TrayWidget[] {
  return entries.map((entry): TrayWidget => {
    if ("widget" in entry) {
      if (entry.widget === "clock") return { name: "clock", every: 1000, render: () => formatClock(new Date(), entry.format), open: entry.open };
      return { name: "system", every: 2000, render: systemRenderer(), open: entry.open ?? systemMonitor() };
    }
    if ("command" in entry) return { name: entry.name ?? entry.command[0]!, every: entry.every, render: () => runCommand(entry.command, entry.every), open: entry.open };
    return { name: entry.name, every: entry.every, render: entry.render, open: entry.open };
  });
}

export class Tray {
  readonly texts: string[];
  private readonly timers: Timer[] = [];
  private stopped = false;

  constructor(
    readonly widgets: TrayWidget[],
    private readonly onChange: () => void,
  ) {
    this.texts = widgets.map(() => "");
  }

  start(): void {
    this.widgets.forEach((widget, index) => {
      void this.update(index);
      this.timers.push(setInterval(() => void this.update(index), widget.every));
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
  }

  private async update(index: number): Promise<void> {
    let text: string;
    try {
      text = oneLine(String(await this.widgets[index]!.render()));
    } catch {
      text = `${this.widgets[index]!.name} !`;
    }
    if (this.stopped || text === this.texts[index]) return;
    this.texts[index] = text;
    this.onChange();
  }
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatClock(date: Date, format: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const tokens: Record<string, () => string> = {
    dddd: () => weekdays[date.getDay()]!,
    ddd: () => weekdays[date.getDay()]!.slice(0, 3),
    YYYY: () => String(date.getFullYear()),
    MMM: () => months[date.getMonth()]!,
    MM: () => pad(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    HH: () => pad(date.getHours()),
    mm: () => pad(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
  };
  return format.replace(/dddd|ddd|YYYY|MMM|MM|DD|D|HH|mm|ss/g, (token) => tokens[token]!());
}

function systemRenderer(): () => string {
  let previous: CpuTimes | undefined;
  return () => {
    const cpu = readCpu();
    const usage = previous ? busy(previous, cpu) : 0;
    previous = cpu;
    return `cpu ${Math.round(usage * 100)}% mem ${Math.round(memoryUsed(readMemory()) * 100)}%`;
  };
}

async function runCommand(command: string[], timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}`);
  return output;
}

function oneLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}
