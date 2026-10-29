import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export function claudeOptions(args: string[]): Partial<Options> {
  const options: Partial<Options> = {};
  const extraArgs: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!flag.startsWith("-")) throw new Error(`qmux claude passes flags to Claude, not "${arg}"`);
    const next = args[index + 1];
    const value = () => inline ?? (next !== undefined && !next.startsWith("-") ? args[++index]! : null);
    switch (flag) {
      case "--resume":
      case "-r":
        options.resume = value() ?? undefined;
        break;
      case "--continue":
      case "-c":
        options.continue = true;
        break;
      case "--permission-mode":
        options.permissionMode = (value() ?? undefined) as PermissionMode | undefined;
        break;
      case "--model":
        options.model = value() ?? undefined;
        break;
      default: {
        if (!flag.startsWith("--")) throw new Error(`qmux claude can't pass the short flag ${flag} to Claude; use its long form`);
        const name = flag.slice(2);
        if (name in extraArgs) throw new Error(`qmux claude can pass ${flag} to Claude only once`);
        extraArgs[name] = value();
      }
    }
  }
  return Object.keys(extraArgs).length > 0 ? { ...options, extraArgs } : options;
}
