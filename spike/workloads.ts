export type Workload = { title: string; command: string[] };

export const echoPane: Workload = { title: "echo", command: ["cat"] };

export function busyWorkloads(count: number, bigFile: string): Workload[] {
  const kinds: Workload[] = [
    { title: "yes", command: ["yes", "the quick brown fox jumps over the lazy dog"] },
    { title: "cat", command: ["sh", "-c", `while :; do cat ${bigFile}; done`] },
    { title: "htop", command: ["htop", "-d", "5"] },
  ];
  return Array.from({ length: count }, (_, index) => kinds[index % kinds.length]!);
}

export async function ensureBigFile(path: string): Promise<string> {
  if (await Bun.file(path).exists()) return path;
  const line = (n: number) => `${n.toString().padStart(8, "0")} \x1b[38;2;${n % 256};${(n * 7) % 256};200mcolour\x1b[0m lorem ipsum dolor sit amet consectetur\n`;
  await Bun.write(path, Array.from({ length: 50_000 }, (_, n) => line(n)).join(""));
  return path;
}
