import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

const valueFlags = new Set([
  "agent",
  "agents",
  "append-system-prompt",
  "append-system-prompt-file",
  "autocompact",
  "debug-file",
  "effort",
  "fallback-model",
  "json-schema",
  "max-budget-usd",
  "model",
  "name",
  "permission-mode",
  "plugin-url",
  "session-id",
  "setting-sources",
  "settings",
  "system-prompt",
  "system-prompt-file",
  "system-prompt-snapshot",
]);

const listFlags = new Set(["add-dir", "allowedTools", "allowed-tools", "disallowedTools", "disallowed-tools", "tools", "betas", "mcp-config", "file", "plugin-dir"]);

export function claudeOptions(args: string[]): Partial<Options> {
  const options: Partial<Options> = {};
  const extraArgs: Record<string, string | null> = {};
  const lists = { additionalDirectories: [] as string[], allowedTools: [] as string[], disallowedTools: [] as string[], tools: [] as string[], plugins: [] as string[] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!flag.startsWith("-")) throw new Error(`qmux claude passes flags to Claude, not "${arg}"`);
    const name = flag.replace(/^--?/, "");
    const next = args[index + 1];
    const optional = () => inline ?? (next !== undefined && !next.startsWith("-") ? args[++index]! : null);
    const required = () => {
      if (inline !== undefined) return inline;
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return args[++index]!;
    };
    const list = () => {
      if (inline !== undefined) return [inline];
      const values: string[] = [];
      while (args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")) values.push(args[++index]!);
      if (values.length === 0) throw new Error(`${flag} needs a value`);
      return values;
    };
    switch (flag) {
      case "--resume":
      case "-r": {
        const id = optional();
        if (id === null) throw new Error("give --resume a session id, or leave it off to pick a session");
        options.resume = id;
        break;
      }
      case "--continue":
      case "-c":
        options.continue = true;
        break;
      case "--permission-mode":
        options.permissionMode = required() as PermissionMode;
        break;
      case "--model":
        options.model = required();
        break;
      case "--add-dir":
        lists.additionalDirectories.push(...list());
        break;
      case "--allowedTools":
      case "--allowed-tools":
        lists.allowedTools.push(...list());
        break;
      case "--disallowedTools":
      case "--disallowed-tools":
        lists.disallowedTools.push(...list());
        break;
      case "--tools":
        lists.tools.push(...list());
        break;
      case "--plugin-dir":
        lists.plugins.push(...list());
        break;
      default: {
        if (!flag.startsWith("--")) throw new Error(`qmux claude can't pass the short flag ${flag} to Claude; use its long form`);
        if (name in extraArgs) throw new Error(`qmux claude can pass ${flag} to Claude only once`);
        if (listFlags.has(name)) {
          const values = list();
          if (values.length > 1) throw new Error(`qmux claude can pass only one value to ${flag}`);
          extraArgs[name] = values[0]!;
        } else extraArgs[name] = valueFlags.has(name) ? required() : optional();
      }
    }
  }
  if (lists.additionalDirectories.length > 0) options.additionalDirectories = lists.additionalDirectories;
  if (lists.allowedTools.length > 0) options.allowedTools = lists.allowedTools;
  if (lists.disallowedTools.length > 0) options.disallowedTools = lists.disallowedTools;
  if (lists.tools.length > 0) options.tools = lists.tools;
  if (lists.plugins.length > 0) options.plugins = lists.plugins.map((path) => ({ type: "local", path }));
  return Object.keys(extraArgs).length > 0 ? { ...options, extraArgs } : options;
}
