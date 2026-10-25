import { readFileSync } from "node:fs";

export type CpuTimes = { idle: number; total: number };
export type Memory = { total: number; available: number };

export function parseCpuTimes(stat: string): CpuTimes {
  const line = stat.split("\n").find((candidate) => candidate.startsWith("cpu "));
  if (!line) return { idle: 0, total: 0 };
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  return { idle: (fields[3] ?? 0) + (fields[4] ?? 0), total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0) };
}

export function busy(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.min(Math.max(1 - (after.idle - before.idle) / total, 0), 1);
}

export function parseMemory(meminfo: string): Memory {
  const values = new Map<string, number>();
  for (const line of meminfo.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  return { total: values.get("MemTotal") ?? 0, available: values.get("MemAvailable") ?? values.get("MemFree") ?? 0 };
}

export function memoryUsed(memory: Memory): number {
  return memory.total === 0 ? 0 : (memory.total - memory.available) / memory.total;
}

export function readCpu(): CpuTimes {
  return parseCpuTimes(readProc("/proc/stat"));
}

export function readMemory(): Memory {
  return parseMemory(readProc("/proc/meminfo"));
}

export function systemMonitor(which: (program: string) => string | null = Bun.which): string[] {
  return [["btop", "htop"].find((program) => which(program) !== null) ?? "top"];
}

function readProc(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
