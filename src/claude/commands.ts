export type SlashCommand = { name: string; description: string; argumentHint?: string };

export const permissionModes = ["default", "acceptEdits", "plan", "auto"] as const;
export type PermissionMode = (typeof permissionModes)[number];

const modeDescriptions: Record<PermissionMode, string> = {
  default: "Ask before edits and commands",
  acceptEdits: "Make file edits without asking",
  plan: "Explore and plan, change nothing",
  auto: "Ask only when Claude judges it risky",
};

const quitCommands: SlashCommand[] = [
  { name: "exit", description: "Quit and print the command to carry on in Claude's TUI" },
  { name: "quit", description: "Same as /exit" },
];

export const localCommands: SlashCommand[] = [...quitCommands, { name: "mode", description: "Change the permission mode", argumentHint: permissionModes.join("|") }];

export function matchCommands(commands: SlashCommand[], input: string, limit = 8, withQuit = true): SlashCommand[] {
  const argument = /^\/mode\s+(\S*)$/i.exec(input)?.[1];
  if (argument !== undefined) {
    return permissionModes.filter((mode) => mode.toLowerCase().startsWith(argument.toLowerCase())).map((mode) => ({ name: `mode ${mode}`, description: modeDescriptions[mode] }));
  }
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const typed = input.slice(1).toLowerCase();
  const local = new Set(localCommands.map((command) => command.name));
  const all = [...localCommands.filter((command) => withQuit || !quitCommands.includes(command)), ...commands.filter((command) => !local.has(command.name))];
  const named = (command: SlashCommand) => command.name.toLowerCase();
  const exact = all.filter((command) => named(command) === typed);
  const starts = all.filter((command) => named(command) !== typed && named(command).startsWith(typed));
  const contains = all.filter((command) => !named(command).startsWith(typed) && named(command).includes(typed));
  return [...exact, ...starts, ...contains].slice(0, limit);
}

export function parseCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { name, description, argumentHint } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !name) return [];
    return [{ name, description: typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "", argumentHint: typeof argumentHint === "string" && argumentHint ? argumentHint : undefined }];
  });
}

export function modeArgument(text: string): string | undefined {
  const match = /^\/mode(?:\s+(.*))?$/is.exec(text.trim());
  return match ? (match[1] ?? "").trim() : undefined;
}

export function parseMode(text: string): PermissionMode | undefined {
  return permissionModes.find((mode) => mode.toLowerCase() === text.toLowerCase());
}

export function nextMode(mode: string | undefined): PermissionMode {
  return permissionModes[(permissionModes.indexOf(mode as PermissionMode) + 1) % permissionModes.length]!;
}

export function isQuit(text: string): boolean {
  return ["/exit", "/quit"].includes(text.trim().toLowerCase());
}
