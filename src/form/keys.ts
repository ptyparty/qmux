import type { FormAction, Focusable } from "./controller.ts";

export type Key = { name: string; ctrl: boolean; shift: boolean; meta: boolean };

export type KeyHint = { keys: string; action: string };

export type EditorPosition = { onFirstLine: boolean; onLastLine: boolean };

const always: Record<string, FormAction> = {
  escape: { type: "cancel" },
  "ctrl+c": { type: "cancel" },
  "ctrl+s": { type: "submit" },
  tab: { type: "next" },
  "shift+tab": { type: "previous" },
};

const editingSingleLine: Record<string, FormAction> = {
  return: { type: "activate" },
  up: { type: "previous" },
  down: { type: "next" },
};

const navigating: Record<string, FormAction> = {
  return: { type: "activate" },
  space: { type: "toggle" },
  up: { type: "up" },
  down: { type: "down" },
  left: { type: "left" },
  right: { type: "right" },
};

const confirmKeys: Record<string, FormAction> = {
  y: { type: "left" },
  n: { type: "right" },
};

export function keyToAction(key: Key, focused: Focusable, position?: EditorPosition): FormAction | null {
  const name = keyName(key);
  return always[name] ?? modeKeys(focused, position)[name] ?? null;
}

export function keyHints(focused: Focusable): KeyHint[] {
  const hints = focusHints(focused);
  const move = hints.some((hint) => hint.keys === "Tab") ? [] : [{ keys: "Tab/⇧Tab", action: "move" }];
  return [...hints, ...move, { keys: "^S", action: "submit" }, { keys: "Esc", action: "cancel" }];
}

function modeKeys(focused: Focusable, position?: EditorPosition): Record<string, FormAction> {
  if (isMultiline(focused)) return multilineEdges(position);
  if (isEditing(focused)) return editingSingleLine;
  if (focused.kind === "input" && focused.element.type === "confirm") return { ...navigating, ...confirmKeys };
  return navigating;
}

function focusHints(focused: Focusable): KeyHint[] {
  if (focused.kind === "submit") return [{ keys: "Enter", action: "submit" }];
  if (focused.kind === "other") return [{ keys: "type", action: "other answer" }];
  if (focused.kind === "note") return [{ keys: "type", action: "note on this slide" }, { keys: "↑", action: "back to the slide" }];
  switch (focused.element.type) {
    case "text":
      return focused.element.multiline
        ? [{ keys: "Tab", action: "next field" }, { keys: "⇧Tab", action: "previous" }, { keys: "Enter", action: "new line" }]
        : [{ keys: "Enter", action: "next" }];
    case "confirm":
      return [{ keys: "y/n ←→", action: "choose" }];
    case "number":
      return [{ keys: "←→", action: "adjust" }];
    case "choice":
      return focused.element.multi
        ? [{ keys: "↑↓", action: "move" }, { keys: "Space", action: "toggle" }]
        : [{ keys: "↑↓", action: "choose" }];
    case "slides":
      return [{ keys: "←→", action: "previous/next slide" }];
  }
}

export function isEditing(focused: Focusable): boolean {
  return focused.kind === "other" || focused.kind === "note" || (focused.kind === "input" && focused.element.type === "text");
}

function multilineEdges(position: EditorPosition | undefined): Record<string, FormAction> {
  return {
    ...(position?.onFirstLine ? { up: { type: "previous" } as const } : {}),
    ...(position?.onLastLine ? { down: { type: "next" } as const } : {}),
  };
}

function isMultiline(focused: Focusable): boolean {
  return focused.kind === "input" && focused.element.type === "text" && Boolean(focused.element.multiline);
}

function keyName(key: Key): string {
  const modifiers = [key.ctrl && "ctrl", key.meta && "meta", key.shift && "shift"].filter(Boolean);
  return [...modifiers, key.name].join("+");
}
