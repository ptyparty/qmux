import { BoxRenderable, SelectRenderable, SelectRenderableEvents, TextRenderable, bold, fg, type CliRenderer, type KeyEvent } from "@opentui/core";
import { theme } from "../mux/theme.ts";
import { styled } from "../ui/styled.ts";
export type Option<T> = { label: string; detail: string; value: T };

export function pick<T>(renderer: CliRenderer, title: string, subtitle: string, items: Option<T>[]): Promise<T | undefined> {
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background, padding: 1 });
  const heading = new TextRenderable(renderer, {
    height: 2,
    content: styled([bold(fg(theme.accent)(title)), fg(theme.muted)(`  ${subtitle}\n↑↓ choose · Enter pick · Esc quit`)]),
  });
  const select = new SelectRenderable(renderer, {
    flexGrow: 1,
    marginTop: 1,
    options: items.map((item) => ({ name: item.label, description: item.detail })),
    backgroundColor: theme.background,
    focusedBackgroundColor: theme.background,
    textColor: theme.text,
    focusedTextColor: theme.text,
    selectedBackgroundColor: theme.surface,
    selectedTextColor: theme.accent,
    descriptionColor: theme.muted,
    selectedDescriptionColor: theme.text,
    showScrollIndicator: true,
    wrapSelection: true,
  });
  root.add(heading);
  root.add(select);
  renderer.root.add(root);
  select.focus();
  renderer.requestRender();
  return new Promise((resolve) => {
    const finish = (choice: T | undefined) => {
      renderer.keyInput.off("keypress", onKey);
      renderer.root.remove(root);
      root.destroyRecursively();
      resolve(choice);
    };
    const onKey = (key: KeyEvent) => {
      if (key.name === "escape" || (key.ctrl && (key.name === "d" || key.name === "c"))) {
        key.preventDefault();
        finish(undefined);
      }
    };
    renderer.keyInput.on("keypress", onKey);
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => finish(items[index]?.value));
  });
}
