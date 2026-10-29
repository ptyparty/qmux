export type SlashCommand = { name: string; description: string; argumentHint?: string };

export const localCommands: SlashCommand[] = [
  { name: "exit", description: "Quit and print the command to carry on in Claude's TUI" },
  { name: "quit", description: "Same as /exit" },
];

export function matchCommands(commands: SlashCommand[], input: string, limit = 8): SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const typed = input.slice(1).toLowerCase();
  const local = new Set(localCommands.map((command) => command.name));
  const all = [...localCommands, ...commands.filter((command) => !local.has(command.name))];
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

export function isQuit(text: string): boolean {
  return ["/exit", "/quit"].includes(text.trim().toLowerCase());
}
