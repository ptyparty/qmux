import type { Axis, Direction } from "./layout.ts";

export type Mode = "normal" | "locked" | "pane" | "tab" | "session" | "tray" | "jobs" | "resize";

export type Command =
  | { type: "mode"; mode: Mode }
  | { type: "focus"; direction: Direction }
  | { type: "cycle-pane"; delta: number }
  | { type: "swap-pane"; direction: Direction }
  | { type: "new-pane"; axis?: Axis }
  | { type: "tab-pane" }
  | { type: "close-pane" }
  | { type: "zoom" }
  | { type: "rename-pane" }
  | { type: "new-tab" }
  | { type: "close-tab" }
  | { type: "restart-tab" }
  | { type: "open-project" }
  | { type: "rename-tab" }
  | { type: "cycle-tab"; delta: number }
  | { type: "move-tab"; delta: number }
  | { type: "go-to-tab"; index: number }
  | { type: "detach" }
  | { type: "close-popup" }
  | { type: "next-attention" }
  | { type: "compose-claude" }
  | { type: "peek-reply" }
  | { type: "dismiss-reply" }
  | { type: "toggle-job" }
  | { type: "toggle-drawer" }
  | { type: "resize-drawer"; delta: number }
  | { type: "dock-job" }
  | { type: "start-layout-jobs" }
  | { type: "last-tab" }
  | { type: "select-widget"; delta: number }
  | { type: "open-widget" }
  | { type: "run-job" }
  | { type: "background-pane" }
  | { type: "select-job"; delta: number }
  | { type: "open-job" }
  | { type: "hide-job" }
  | { type: "rerun-job" }
  | { type: "promote-job" }
  | { type: "close-job" }
  | { type: "quit" };

export type Binding = { keys: string[]; command: Command; then?: Mode };

export type Hint = { keys: string; description: string };

export type Key = { name: string; ctrl: boolean; meta: boolean; shift: boolean };

type ModeKeys = { bindings: Binding[]; hints: Hint[] };

const dvorak: Record<Direction, string> = { left: "h", up: "t", down: "n", right: "s" };
const vim: Record<Direction, string> = { left: "h", down: "j", up: "k", right: "l" };

const modeSwitches: { key: string; mode: Mode; keys: string; description: string }[] = [
  { key: "ctrl+p", mode: "pane", keys: "^p", description: "pane" },
  { key: "ctrl+t", mode: "tab", keys: "^t", description: "tab" },
  { key: "ctrl+s", mode: "jobs", keys: "^s", description: "jobs" },
  { key: "ctrl+o", mode: "session", keys: "^o", description: "session" },
  { key: "ctrl+g", mode: "locked", keys: "^g", description: "lock" },
];

const backToNormal: Binding = { keys: ["escape", "return"], command: { type: "mode", mode: "normal" } };
const backHint: Hint = { keys: "Esc", description: "back" };

function directional(letters: Record<Direction, string>, prefix: string, command: (direction: Direction) => Command): Binding[] {
  return (Object.entries(letters) as [Direction, string][]).map(([direction, letter]) => ({
    keys: [`${prefix}${letter}`, `${prefix}${direction}`],
    command: command(direction),
  }));
}

export const keymap: Record<Mode, ModeKeys> = {
  normal: {
    bindings: [
      ...modeSwitches.map(({ key, mode }) => ({ keys: [key], command: { type: "mode", mode } }) satisfies Binding),
      ...directional(dvorak, "alt+", (direction) => ({ type: "focus", direction })),
      { keys: ["alt+o"], command: { type: "cycle-pane", delta: -1 } },
      { keys: ["alt+e"], command: { type: "cycle-pane", delta: 1 } },
      { keys: ["alt+a"], command: { type: "next-attention" } },
      { keys: ["alt+c"], command: { type: "compose-claude" } },
      { keys: ["alt+p"], command: { type: "peek-reply" } },
      { keys: ["alt+x"], command: { type: "dismiss-reply" } },
      { keys: ["alt+j"], command: { type: "toggle-job" } },
      { keys: ["alt+d"], command: { type: "toggle-drawer" } },
    ],
    hints: [
      { keys: "Alt h/t/n/s", description: "focus" },
      { keys: "Alt o/e", description: "prev/next pane" },
      { keys: "Alt a", description: "next agent needing you" },
      { keys: "Alt c", description: "message Claude" },
      { keys: "Alt p", description: "peek at a reply" },
      { keys: "Alt j", description: "hide or reopen a job or question" },
      { keys: "Alt d", description: "shell drawer" },
    ],
  },
  locked: {
    bindings: [{ keys: ["ctrl+g"], command: { type: "mode", mode: "normal" } }],
    hints: [{ keys: "^g", description: "unlock" }],
  },
  pane: {
    bindings: [
      ...directional(vim, "", (direction) => ({ type: "focus", direction })),
      ...directional(dvorak, "alt+", (direction) => ({ type: "swap-pane", direction })),
      { keys: ["p"], command: { type: "cycle-pane", delta: 1 } },
      { keys: ["n"], command: { type: "new-pane" }, then: "normal" },
      { keys: ["d"], command: { type: "new-pane", axis: "column" }, then: "normal" },
      { keys: ["r"], command: { type: "new-pane", axis: "row" }, then: "normal" },
      { keys: ["s"], command: { type: "tab-pane" }, then: "normal" },
      { keys: ["x"], command: { type: "close-pane" }, then: "normal" },
      { keys: ["f"], command: { type: "zoom" }, then: "normal" },
      { keys: ["c"], command: { type: "rename-pane" }, then: "normal" },
      { keys: ["e"], command: { type: "mode", mode: "resize" } },
      backToNormal,
    ],
    hints: [
      { keys: "←↓↑→/hjkl", description: "focus" },
      { keys: "Alt h/t/n/s", description: "move" },
      { keys: "n", description: "new" },
      { keys: "d", description: "new below" },
      { keys: "r", description: "new right" },
      { keys: "s", description: "new pane tab" },
      { keys: "x", description: "close" },
      { keys: "f", description: "zoom" },
      { keys: "c", description: "rename" },
      { keys: "e", description: "resize drawer" },
      backHint,
    ],
  },
  tab: {
    bindings: [
      { keys: ["h", "left", "up"], command: { type: "cycle-tab", delta: -1 } },
      { keys: ["s", "right", "down"], command: { type: "cycle-tab", delta: 1 } },
      { keys: ["t"], command: { type: "move-tab", delta: -1 } },
      { keys: ["n"], command: { type: "move-tab", delta: 1 } },
      { keys: ["c"], command: { type: "new-tab" }, then: "normal" },
      { keys: ["x"], command: { type: "close-tab" }, then: "normal" },
      { keys: ["r"], command: { type: "rename-tab" }, then: "normal" },
      { keys: ["shift+r"], command: { type: "restart-tab" }, then: "normal" },
      { keys: ["o"], command: { type: "open-project" }, then: "normal" },
      { keys: ["a"], command: { type: "last-tab" }, then: "normal" },
      { keys: ["w"], command: { type: "mode", mode: "tray" } },
      ...Array.from({ length: 9 }, (_, index): Binding => ({ keys: [String(index + 1)], command: { type: "go-to-tab", index }, then: "normal" })),
      backToNormal,
    ],
    hints: [
      { keys: "h/s", description: "prev/next" },
      { keys: "t/n", description: "move" },
      { keys: "c", description: "new" },
      { keys: "x", description: "close" },
      { keys: "r", description: "rename" },
      { keys: "R", description: "restart" },
      { keys: "o", description: "open project" },
      { keys: "a", description: "last tab" },
      { keys: "w", description: "tray" },
      { keys: "1-9", description: "go to" },
      backHint,
    ],
  },
  tray: {
    bindings: [
      { keys: ["h", "left", "up"], command: { type: "select-widget", delta: -1 } },
      { keys: ["s", "right", "down"], command: { type: "select-widget", delta: 1 } },
      { keys: ["return"], command: { type: "open-widget" }, then: "normal" },
      { keys: ["escape"], command: { type: "mode", mode: "normal" } },
    ],
    hints: [{ keys: "h/s", description: "prev/next widget" }, { keys: "Enter", description: "open" }, backHint],
  },
  jobs: {
    bindings: [
      { keys: ["n"], command: { type: "run-job" }, then: "normal" },
      { keys: ["b"], command: { type: "background-pane" }, then: "normal" },
      { keys: ["up"], command: { type: "select-job", delta: -1 } },
      { keys: ["down"], command: { type: "select-job", delta: 1 } },
      { keys: ["return"], command: { type: "open-job" }, then: "normal" },
      { keys: ["h"], command: { type: "hide-job" }, then: "normal" },
      { keys: ["r"], command: { type: "rerun-job" } },
      { keys: ["p"], command: { type: "promote-job" }, then: "normal" },
      { keys: ["d"], command: { type: "dock-job" } },
      { keys: ["s"], command: { type: "start-layout-jobs" }, then: "normal" },
      { keys: ["x"], command: { type: "close-job" } },
      { keys: ["escape"], command: { type: "mode", mode: "normal" } },
    ],
    hints: [
      { keys: "n", description: "new job" },
      { keys: "b", description: "background this pane" },
      { keys: "↑↓", description: "select" },
      { keys: "Enter", description: "open" },
      { keys: "h", description: "hide" },
      { keys: "r", description: "rerun" },
      { keys: "p", description: "to pane" },
      { keys: "d", description: "dock" },
      { keys: "s", description: "start layout jobs" },
      { keys: "x", description: "close" },
      backHint,
    ],
  },
  resize: {
    bindings: [
      { keys: ["up", "k", "t"], command: { type: "resize-drawer", delta: 1 } },
      { keys: ["down", "j", "n"], command: { type: "resize-drawer", delta: -1 } },
      backToNormal,
    ],
    hints: [{ keys: "↑/k/t", description: "taller" }, { keys: "↓/j/n", description: "shorter" }, backHint],
  },
  session: {
    bindings: [
      { keys: ["d"], command: { type: "detach" }, then: "normal" },
      { keys: ["x"], command: { type: "close-popup" }, then: "normal" },
      { keys: ["shift+q"], command: { type: "quit" } },
      backToNormal,
    ],
    hints: [{ keys: "d", description: "detach" }, { keys: "x", description: "close popup" }, { keys: "Q", description: "quit" }, backHint],
  },
};

export function keyName(key: Key): string {
  const modifiers = [key.ctrl && "ctrl", key.meta && "alt", key.shift && "shift"].filter(Boolean);
  return [...modifiers, key.name].join("+");
}

export function lookup(mode: Mode, key: Key): Binding | undefined {
  const name = keyName(key);
  return keymap[mode].bindings.find((binding) => binding.keys.includes(name));
}

export function hints(mode: Mode): Hint[] {
  return keymap[mode].hints;
}

export function modeHints(): (Hint & { mode: Mode })[] {
  return modeSwitches.map(({ keys, description, mode }) => ({ keys, description, mode }));
}
