import { createCliRenderer } from "@opentui/core";
import { parseArgs } from "node:util";
import { grid, Pane } from "./pane.ts";
import { ReadScheduler } from "../src/mux/pty.ts";
import { busyWorkloads, echoPane, ensureBigFile, type Workload } from "./workloads.ts";

const { values } = parseArgs({
  options: {
    panes: { type: "string", default: "16" },
    columns: { type: "string", default: "4" },
    "big-file": { type: "string", default: "/tmp/qmux-bench-big.txt" },
    fps: { type: "string", default: "60" },
    workloads: { type: "string" },
    "budget-ms": { type: "string", default: "6" },
    "window-ms": { type: "string", default: "16" },
  },
});

const count = Number(values.panes);
const bigFile = await ensureBigFile(values["big-file"]!);
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: Number(values.fps), maxFps: Number(values.fps) });
const workloads: Workload[] = values.workloads
  ? await Bun.file(values.workloads).json()
  : [echoPane, ...busyWorkloads(count - 1, bigFile)];
const scheduler = new ReadScheduler(Number(values["budget-ms"]), Number(values["window-ms"]));
const panes = workloads.map((workload) => new Pane(renderer, workload.command, workload.title, scheduler));
renderer.root.add(grid(renderer, panes, Number(values.columns)));
panes[0]!.focus();

function shutdown(): never {
  for (const pane of panes) pane.kill();
  renderer.destroy();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "q") shutdown();
});
