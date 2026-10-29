import { TextRenderable, bold, fg, type CliRenderer, type KeyEvent, type TextareaRenderable } from "@opentui/core";
import { theme } from "../mux/theme.ts";
import { styled } from "../ui/styled.ts";
import { matchCommands, type SlashCommand } from "./commands.ts";

export type CompletionOptions = {
  commands: () => SlashCommand[];
  submit: () => void;
  quit?: boolean;
  keepsEscape?: () => boolean;
};

export class SlashCompletion {
  readonly list: TextRenderable;
  private matches: SlashCommand[] = [];
  private selected = 0;
  private hiddenFor: string | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly input: TextareaRenderable,
    private readonly options: CompletionOptions,
  ) {
    this.list = new TextRenderable(renderer, { flexShrink: 0, wrapMode: "none", visible: false, bg: theme.surface, paddingLeft: 1 });
  }

  update(): void {
    const text = this.input.plainText;
    if (this.hiddenFor !== undefined && this.hiddenFor !== text) this.hiddenFor = undefined;
    const matches = this.hiddenFor === undefined ? matchCommands(this.options.commands(), text, 8, this.options.quit ?? true) : [];
    if (matches.map((command) => command.name).join() !== this.matches.map((command) => command.name).join()) this.selected = 0;
    this.matches = matches;
    this.list.visible = matches.length > 0;
    if (matches.length > 0) {
      this.list.height = matches.length;
      const width = Math.max(this.renderer.width - 4, 20);
      this.list.content = styled(
        matches.flatMap((command, index) => {
          const chosen = index === this.selected;
          const hint = command.argumentHint && command.argumentHint.length > 30 ? `${command.argumentHint.slice(0, 29)}…` : command.argumentHint;
          const name = `/${command.name}${hint ? ` ${hint}` : ""}`;
          const description = fitWidth(command.description, Math.max(width - Bun.stringWidth(name) - 4, 0));
          return [...(index > 0 ? ["\n"] : []), bold(fg(chosen ? theme.accent : theme.text)(`${chosen ? "›" : " "} ${name}`)), fg(theme.muted)(`  ${description}`)];
        }),
      );
    }
    this.renderer.requestRender();
  }

  handleKey(key: KeyEvent): boolean {
    if (this.matches.length === 0) return false;
    const command = this.matches[this.selected]!;
    if (key.name === "up" || key.name === "down") {
      this.selected = (this.selected + (key.name === "up" ? -1 : 1) + this.matches.length) % this.matches.length;
      this.update();
    } else if (key.name === "tab") this.complete(command, false);
    else if (key.name === "return" && !key.meta) this.complete(command, true);
    else if (key.name === "escape") {
      this.hiddenFor = this.input.plainText;
      this.update();
      return this.options.keepsEscape?.() ?? true;
    } else return false;
    return true;
  }

  private complete(command: SlashCommand, run: boolean): void {
    this.input.setText(`/${command.name}${run ? "" : " "}`);
    this.input.gotoBufferEnd();
    if (run) this.options.submit();
  }
}

function fitWidth(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  let cut = "";
  for (const char of text) {
    if (Bun.stringWidth(cut + char) > width - 1) break;
    cut += char;
  }
  return width > 0 ? `${cut}…` : "";
}
