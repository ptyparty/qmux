export type RunningJob = { name: string; command?: string[] };

type Token = { text: string; operator: boolean };

const operators = ["&&", "||", ";;", ";", "|", "&", "(", ")", "{", "}", "\n"];
const keywords = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "time"]);
const launchers: Record<string, { options: Set<string>; positional: number }> = {
  env: { options: new Set(["-u", "--unset", "-C", "--chdir"]), positional: 0 },
  sudo: { options: new Set(["-u", "-g", "-h", "-p", "-C", "-D"]), positional: 0 },
  nohup: { options: new Set(), positional: 0 },
  exec: { options: new Set(["-a"]), positional: 0 },
  nice: { options: new Set(["-n", "--adjustment"]), positional: 0 },
  timeout: { options: new Set(["-s", "--signal", "-k", "--kill-after"]), positional: 1 },
  command: { options: new Set(), positional: 0 },
};
const shells = new Set(["bash", "sh", "zsh", "fish", "nu", "dash"]);

export function refuseAgentCommand(patterns: string[], command: string, background: boolean, running: RunningJob[]): string | undefined {
  for (const words of simpleCommands(command)) {
    const pattern = patterns.find((candidate) => runs(words[0]!, candidate));
    if (!pattern) continue;
    const howTo = `In qmux, run \`${pattern}\` with the Bash tool's run_in_background: true and without --detach, so it runs as a job the user can watch. Read its output to tell when it is ready.`;
    if (!background) return `${pattern} must run in the background. ${howTo}`;
    if (words.slice(1).some((word) => word === "--detach" || word.startsWith("--detach="))) return `Drop --detach from ${pattern}. ${howTo}`;
    const already = running.find((job) => job.command !== undefined && simpleCommands(job.command.map(quote).join(" ")).some((job) => runs(job[0]!, pattern)));
    if (already) return `${pattern} is already running as the job "${already.name}" in this tab. Stop that job first, or restart parts of it, rather than starting another.`;
  }
  return undefined;
}

function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  const finish = () => {
    const words = programWords(current);
    const [program, flag, script] = words;
    const shell = program !== undefined && shells.has(program.split("/").pop()!);
    if (shell && flag === "-c" && script !== undefined) commands.push(...simpleCommands(script));
    else if (shell && flag !== undefined && !flag.startsWith("-")) commands.push(words.slice(1));
    else if (program) commands.push(words);
    current = [];
  };
  for (const token of tokens(command)) {
    if (token.operator) finish();
    else current.push(token.text);
  }
  finish();
  return commands;
}

function programWords(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (keywords.has(word) || /^\w+=/.test(word)) {
      index++;
      continue;
    }
    const launcher = launchers[word];
    if (!launcher) break;
    index++;
    while (index < words.length && words[index]!.startsWith("-")) index += launcher.options.has(words[index]!) ? 2 : 1;
    while (index < words.length && /^\w+=/.test(words[index]!)) index++;
    index += launcher.positional;
  }
  return words.slice(index);
}

function tokens(command: string): Token[] {
  const found: Token[] = [];
  let word = "";
  let started = false;
  const push = () => {
    if (started) found.push({ text: word, operator: false });
    word = "";
    started = false;
  };
  for (let index = 0; index < command.length; ) {
    const char = command[index]!;
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      word += command.slice(index + 1, end < 0 ? undefined : end);
      started = true;
      index = end < 0 ? command.length : end + 1;
    } else if (char === '"') {
      let end = index + 1;
      for (; end < command.length && command[end] !== '"'; end++) {
        if (command[end] === "\\") end++;
        word += command[end] ?? "";
      }
      started = true;
      index = end + 1;
    } else if (char === "\\") {
      word += command[index + 1] ?? "";
      started = true;
      index += 2;
    } else if (char === " " || char === "\t") {
      push();
      index++;
    } else if (char === ">" || char === "<") {
      if (/^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      push();
      index++;
      while (index < command.length && /[>&]/.test(command[index]!)) index++;
      while (command[index] === " ") index++;
      while (index < command.length && !/[\s;&|()]/.test(command[index]!)) index++;
    } else if (char === "$" && command[index + 1] === "(") {
      push();
      found.push({ text: "$(", operator: true });
      index += 2;
    } else {
      const operator = operators.find((candidate) => command.startsWith(candidate, index));
      if (operator) {
        push();
        found.push({ text: operator, operator: true });
        index += operator.length;
      } else {
        word += char;
        started = true;
        index++;
      }
    }
  }
  push();
  return found;
}

function runs(word: string, pattern: string): boolean {
  return word === pattern || word.endsWith(`/${pattern}`);
}
