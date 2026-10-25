import { describe, expect, test } from "bun:test";
import { busy, memoryUsed, parseCpuTimes, parseMemory, systemMonitor } from "./system.ts";

describe("system stats", () => {
  test("reads total CPU time, counting iowait as idle", () => {
    expect(parseCpuTimes("cpu  10 0 10 30 10 0 0 0 0 0\ncpu0 5 0 5 15 5 0 0 0 0 0\n")).toEqual({ idle: 40, total: 60 });
  });

  test("measures how busy the CPU was between two readings", () => {
    expect(busy({ idle: 0, total: 0 }, { idle: 25, total: 100 })).toBe(0.75);
    expect(busy({ idle: 5, total: 5 }, { idle: 5, total: 5 })).toBe(0);
  });

  test("reads memory in bytes and counts available memory as free", () => {
    const memory = parseMemory("MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    250 kB\n");
    expect(memory).toEqual({ total: 1_024_000, available: 256_000 });
    expect(memoryUsed(memory)).toBe(0.75);
  });

  test("opens the best installed system monitor", () => {
    const installed = (programs: string[]) => (program: string) => (programs.includes(program) ? `/usr/bin/${program}` : null);
    expect(systemMonitor(installed(["htop", "btop"]))).toEqual(["btop"]);
    expect(systemMonitor(installed(["htop"]))).toEqual(["htop"]);
    expect(systemMonitor(installed([]))).toEqual(["top"]);
  });
});
