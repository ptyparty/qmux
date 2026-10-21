import { parseArgs } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { busyWorkloads, echoPane, ensureBigFile, type Workload } from "./workloads.ts";

type Target = { command: string[]; env: Record<string, string | undefined>; processIds: (rootPid: number) => number[]; cleanup: () => Promise<void> };

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "qmux" },
    panes: { type: "string", default: "16" },
    busy: { type: "string" },
    probes: { type: "string", default: "200" },
    cols: { type: "string", default: "200" },
    rows: { type: "string", default: "60" },
    warmup: { type: "string", default: "4" },
    "big-file": { type: "string", default: "/tmp/qmux-bench-big.txt" },
    fps: { type: "string", default: "60" },
    throughput: { type: "boolean", default: false },
  },
});

const paneCount = Number(values.panes);
const busyCount = values.busy === undefined ? paneCount - 1 : Number(values.busy);
const bigFile = await ensureBigFile(values["big-file"]!);
const doneMarker = "QMUX" + "BENCHDONE";
const firstPane = values.throughput
  ? { title: "throughput", command: ["sh", "-c", `sleep 1; for i in 1 2 3 4 5 6 7 8 9 10; do cat ${bigFile}; done; echo ${doneMarker.slice(0, 4)}""${doneMarker.slice(4)}; sleep 600`] }
  : echoPane;
const workloads = [firstPane, ...busyWorkloads(busyCount, bigFile), ...idleWorkloads(paneCount - 1 - busyCount)];
const target = values.target === "zellij" ? await zellijTarget(workloads) : await qmuxTarget(workloads);

const decoder = new TextDecoder();
let output = "";
let drawn = 0;
let sawBorder = false;
const pty = new Bun.Terminal({
  cols: Number(values.cols),
  rows: Number(values.rows),
  data: (_, data) => {
    output += decoder.decode(data, { stream: true });
    drawn += data.length;
    if (!sawBorder && output.includes("─")) sawBorder = true;
    if (output.length > 1_000_000) output = output.slice(-200_000);
  },
});
const child = Bun.spawn(["setsid", "--ctty", ...target.command], { terminal: pty, env: target.env });

const launched = performance.now();
let allOutput = "";
if (values.throughput) {
  const deadline = launched + 120_000;
  let finished = false;
  while (performance.now() < deadline && !finished) {
    allOutput += output;
    output = "";
    finished = allOutput.includes(doneMarker);
    if (allOutput.length > 100_000) allOutput = allOutput.slice(-1000);
    await Bun.sleep(5);
  }
  const seconds = (performance.now() - launched) / 1000 - 1;
  child.kill();
  await Bun.sleep(500);
  if (!child.killed) child.kill("SIGKILL");
  pty.close();
  await target.cleanup();
  console.log(JSON.stringify({ target: values.target, mode: "throughput", busy: busyCount, finished, seconds: round(seconds), megabytes: round((Bun.file(bigFile).size * 10) / 1e6) }));
  process.exit(0);
}
await Bun.sleep(Number(values.warmup) * 1000);
const processIds = target.processIds(child.pid);
if (child.exitCode !== null || drawn < 1000 || !sawBorder) {
  console.error(`${values.target} did not start; it drew ${drawn} bytes:\n${JSON.stringify(output.slice(-500))}`);
  child.kill("SIGKILL");
  await target.cleanup();
  process.exit(1);
}
const cpuBefore = cpuTicks(processIds);
const started = performance.now();
const latencies: number[] = [];
let timeouts = 0;

for (let probe = 0; probe < Number(values.probes); probe++) {
  const char = String.fromCodePoint(0x4e00 + probe);
  output = "";
  const sent = performance.now();
  pty.write(char);
  const seen = await waitFor(() => output.includes(char), 2000);
  if (seen) latencies.push(performance.now() - sent);
  else {
    timeouts++;
    if (process.env.QMUX_BENCH_DEBUG) {
      const state = (() => { try { return readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] + " wchan=" + readFileSync(`/proc/${child.pid}/wchan`, "utf8"); } catch (e) { return String(e); } })();
      console.error(`probe ${probe} timed out; exit=${child.exitCode} state=${state}; output: ${JSON.stringify(output.slice(0, 200))}`);
    }
  }
  await Bun.sleep(50 + Math.random() * 100);
}

const elapsedSeconds = (performance.now() - started) / 1000;
const cpuPercent = ((cpuTicks(processIds) - cpuBefore) / 100 / elapsedSeconds) * 100;
const rssMb = processIds.reduce((total, pid) => total + rss(pid), 0) / 1024;

child.kill();
const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
if (!exited) child.kill("SIGKILL");
pty.close();
await target.cleanup();

latencies.sort((a, b) => a - b);
const summary = {
  target: values.target,
  panes: paneCount,
  busy: busyCount,
  size: `${values.cols}x${values.rows}`,
  probes: latencies.length + timeouts,
  timeouts,
  p50: percentile(latencies, 0.5),
  p95: percentile(latencies, 0.95),
  p99: percentile(latencies, 0.99),
  max: latencies.at(-1) ?? null,
  cpuPercent: round(cpuPercent),
  rssMb: round(rssMb),
  processes: processIds.length,
};
console.log(JSON.stringify(summary));
process.exit(0);

function idleWorkloads(count: number): Workload[] {
  return Array.from({ length: Math.max(count, 0) }, () => ({ title: "idle", command: ["sh", "-c", "while :; do sleep 60; done"] }));
}

async function qmuxTarget(workloadsToRun: Workload[]): Promise<Target> {
  const workloadFile = `/tmp/qmux-bench-workloads-${process.pid}.json`;
  await Bun.write(workloadFile, JSON.stringify(workloadsToRun));
  const command = [process.execPath, `${import.meta.dir}/grid-app.ts`, "--workloads", workloadFile, "--fps", values.fps!];
  return { command, env: { ...process.env }, processIds: (rootPid) => [rootPid], cleanup: async () => {} };
}

async function zellijTarget(workloadsToRun: Workload[]): Promise<Target> {
  const session = `qmux-bench-${process.pid}`;
  const dir = `/tmp/qmux-bench-zellij-${process.pid}`;
  await Bun.write(`${dir}/config.kdl`, 'show_startup_tips false\nshow_release_notes false\npane_frames true\nsession_serialization false\n');
  await Bun.write(`${dir}/layout.kdl`, zellijLayout(workloadsToRun, 4));
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
  for (const key of Object.keys(env)) if (key.startsWith("ZELLIJ")) delete env[key];
  return {
    command: ["zellij", "--config", `${dir}/config.kdl`, "--session", session, "--new-session-with-layout", `${dir}/layout.kdl`],
    env,
    processIds: (rootPid) => [rootPid, ...processesMatching((cmdline) => cmdline.includes("zellij") && cmdline.includes("--server") && cmdline.includes(session))],
    cleanup: async () => {
      await Bun.spawn(["zellij", "kill-session", session], { env, stdout: "ignore", stderr: "ignore" }).exited;
      await Bun.spawn(["zellij", "delete-session", "--force", session], { env, stdout: "ignore", stderr: "ignore" }).exited;
    },
  };
}

function zellijLayout(workloadsToRun: Workload[], columns: number): string {
  const rows: string[] = [];
  for (let start = 0; start < workloadsToRun.length; start += columns) {
    const panes = workloadsToRun.slice(start, start + columns).map((workload, offset) => {
      const [program, ...args] = workload.command;
      const focus = start + offset === 0 ? " focus=true" : "";
      const argList = args.length ? ` { args ${args.map((arg) => JSON.stringify(arg)).join(" ")}; }` : "";
      return `      pane command=${JSON.stringify(program)} name=${JSON.stringify(workload.title)}${focus}${argList}`;
    });
    rows.push(`    pane split_direction="vertical" {\n${panes.join("\n")}\n    }`);
  }
  return `layout {\n  pane split_direction="horizontal" {\n${rows.join("\n")}\n  }\n}\n`;
}

function processesMatching(predicate: (cmdline: string) => boolean): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return predicate(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
      } catch {
        return false;
      }
    })
    .map(Number);
}

function cpuTicks(pids: number[]): number {
  return pids.reduce((total, pid) => {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return total + Number(fields[11]) + Number(fields[12]);
    } catch {
      return total;
    }
  }, 0);
}

function rss(pid: number): number {
  try {
    const match = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(1);
  }
  return predicate();
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
