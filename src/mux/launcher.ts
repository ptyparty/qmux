import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer } from "@opentui/core";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { styled, type Part } from "../ui/styled.ts";
import { theme } from "./theme.ts";
import type { Prompt } from "./workspace.ts";

export class Launcher {
  private readonly box: BoxRenderable;
  private readonly detail: TextRenderable;
  private readonly input: TextRenderable;
  private readonly matches: TextRenderable;
  private readonly footer: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "20%",
      top: "15%",
      width: "60%",
      zIndex: 200,
      visible: false,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      titleColor: theme.accent,
      backgroundColor: theme.surface,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.detail = new TextRenderable(renderer, { fg: theme.muted });
    this.input = new TextRenderable(renderer, {});
    this.matches = new TextRenderable(renderer, { marginTop: 1, wrapMode: "none" });
    this.footer = new TextRenderable(renderer, { fg: theme.muted, marginTop: 1 });
    for (const child of [this.detail, this.input, this.matches, this.footer]) this.box.add(child);
    renderer.root.add(this.box);
  }

  render(prompt: Prompt | undefined): void {
    this.box.visible = prompt !== undefined;
    if (!prompt) return;
    this.box.title = ` ${prompt.title} `;
    this.detail.visible = prompt.detail !== undefined;
    this.detail.content = prompt.detail ?? "";
    this.input.content = styled([bold(fg(theme.accent)("› ")), fg(theme.text)(prompt.text), bg(theme.text)(" ")]);
    const matches = prompt.matches;
    this.matches.visible = matches !== undefined;
    if (matches) this.matches.content = matches.length > 0 ? styled(matchLines(prompt)) : styled([fg(theme.muted)("No matching projects")]);
    this.footer.content = matches ? "↑↓ select · Tab complete · Enter open · Esc cancel" : "Enter confirm · Esc cancel";
    const matchRows = matches ? Math.max(matches.length, 1) + 1 : 0;
    this.box.height = 2 + (prompt.detail ? 1 : 0) + 1 + matchRows + 2;
  }
}

function matchLines(prompt: Prompt): Part[] {
  const parts: Part[] = [];
  prompt.matches!.forEach((match, index) => {
    if (index > 0) parts.push("\n");
    const selected = index === prompt.selected;
    const name = match.name.padEnd(22);
    const where = shortenHome(dirname(match.dir));
    parts.push(selected ? bold(fg(theme.background)(bg(theme.accent)(` ${name} `))) : fg(theme.text)(` ${name} `));
    parts.push(fg(theme.muted)(`  ${where}`));
  });
  return parts;
}

function shortenHome(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
