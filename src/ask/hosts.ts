export const hostNames = ["auto", "zellij", "tmux", "none"] as const;
export type HostName = (typeof hostNames)[number];
type ResolvedHost = Exclude<HostName, "auto">;

export type Launch = { host: ResolvedHost; message: string };

export class HostLaunchError extends Error {}

const launchFailureWindowMs = 300;

export function resolveHost(requested: HostName, env: Record<string, string | undefined> = process.env): ResolvedHost {
  if (requested !== "auto") return requested;
  if (env.ZELLIJ !== undefined || env.ZELLIJ_SESSION_NAME !== undefined) return "zellij";
  if (env.TMUX !== undefined) return "tmux";
  return "none";
}

export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

export function formCommand(askId: string, asksDir: string): string[] {
  return [...selfCommand(), "form", "--ask", askId, "--asks-dir", asksDir];
}

export async function launchForm(host: ResolvedHost, askId: string, title: string, asksDir: string): Promise<Launch> {
  const command = formCommand(askId, asksDir);
  switch (host) {
    case "zellij":
      await runChecked(zellijArgs(command, title));
      return { host, message: "Opened a floating pane in the current zellij session" };
    case "tmux":
      await spawnPopup(tmuxArgs(command, title));
      return { host, message: "Opened a tmux popup" };
    case "none":
      return { host, message: `No terminal host detected; the user can answer by running: ${shellQuote(command)}` };
  }
}

export function zellijArgs(command: string[], title: string): string[] {
  return [
    "zellij", "run",
    "--floating", "--close-on-exit", "--pinned", "true",
    "--name", `qmux: ${title}`,
    "--width", "80%", "--height", "80%", "--x", "10%", "--y", "10%",
    "--", ...command,
  ];
}

export function tmuxArgs(command: string[], title: string): string[] {
  return ["tmux", "display-popup", "-E", "-w", "80%", "-h", "80%", "-T", ` qmux: ${title} `, shellQuote(command)];
}

export function shellQuote(args: string[]): string {
  return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(" ");
}

async function spawnPopup(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const exitedEarly = await Promise.race([child.exited.then(() => true), Bun.sleep(launchFailureWindowMs).then(() => false)]);
  if (!exitedEarly) {
    child.unref();
    return;
  }
  if (child.exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new HostLaunchError(`${args[0]} exited with ${child.exitCode}: ${stderr.trim()}`);
  }
}

async function runChecked(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new HostLaunchError(`${args[0]} exited with ${code}: ${stderr.trim()}`);
}
