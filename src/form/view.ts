import {
  BoxRenderable,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  bold,
  dim,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { FormController, type FormResult, type Focusable } from "./controller.ts";
import { isEditing, keyHints, keyToAction, type EditorPosition } from "./keys.ts";
import { fitImage, imageIdColor, newImageId, placeholderLines, readImage, terminalImageOutput, uploadCommands, type ImageOutput } from "./image.ts";
import type { ChoiceElement, ConfirmElement, Element, ImageElement, NumberElement, TextElement } from "./schema.ts";

const palette = {
  accent: "#7e9cd8",
  muted: "#727169",
  error: "#e82424",
  selected: "#98bb6c",
  border: "#54546d",
};

type Editor = InputRenderable | TextareaRenderable;

interface ElementView {
  readonly root: BoxRenderable;
  sync(): void;
  flush(): void;
  editorFor(focusable: Focusable): Editor | undefined;
}

export function runForm(renderer: CliRenderer, controller: FormController, images: ImageOutput = terminalImageOutput()): Promise<FormResult> {
  return new Promise((resolve) => {
    const view = new FormView(renderer, controller, images, resolve);
    view.sync();
  });
}

class FormView {
  private readonly views: Map<Element, ElementView>;
  private readonly scroll: ScrollBoxRenderable;
  private readonly submit: TextRenderable;
  private readonly hints: TextRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly controller: FormController,
    private readonly images: ImageOutput,
    private readonly resolve: (result: FormResult) => void,
  ) {
    const frame = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      title: ` ${controller.spec.title} `,
      titleColor: palette.accent,
      flexDirection: "column",
      width: "100%",
      height: "100%",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, contentOptions: { flexDirection: "column", gap: 1 } });
    if (controller.spec.description) {
      this.scroll.add(new TextRenderable(renderer, { content: controller.spec.description, fg: palette.muted }));
    }
    this.views = new Map(controller.spec.elements.map((element) => [element, this.createView(element)]));
    for (const view of this.views.values()) this.scroll.add(view.root);
    this.submit = new TextRenderable(renderer, { id: "submit" });
    this.scroll.add(this.submit);
    this.hints = new TextRenderable(renderer, { fg: palette.muted, flexShrink: 0 });
    for (const box of [this.scroll.content, this.scroll.viewport]) {
      const recalculate = box.onSizeChange;
      box.onSizeChange = () => {
        recalculate?.call(box);
        this.syncHints();
      };
    }
    frame.add(this.scroll);
    frame.add(this.hints);
    renderer.root.add(frame);
    renderer.keyInput.on("keypress", this.onKey);
  }

  sync(): void {
    const visible = new Set(this.controller.visibleElements());
    for (const [element, view] of this.views) {
      view.root.visible = visible.has(element);
      if (visible.has(element)) view.sync();
    }
    this.syncSubmit();
    this.syncFocus();
    this.syncHints();
    if (this.controller.result) this.finish(this.controller.result);
  }

  private readonly changed = (): void => {
    this.sync();
    this.scrollToFocus();
  };

  private readonly syncHints = (): void => {
    this.hints.content = renderHints(this.controller.focused(), this.overflows());
  };

  private readonly onKey = (key: KeyEvent): void => {
    const focused = this.controller.focused();
    const action = keyToAction(key, focused, editorPosition(this.editorFor(focused)));
    if (!action) return this.page(key);
    key.preventDefault();
    for (const view of this.views.values()) view.flush();
    this.controller.dispatch(action);
    this.sync();
    this.scrollToFocus();
  };

  private page(key: KeyEvent): void {
    const direction = key.name === "pageup" ? -1 : key.name === "pagedown" ? 1 : 0;
    if (direction === 0) return;
    key.preventDefault();
    this.scroll.scrollBy(direction * 0.8, "viewport");
  }

  private finish(result: FormResult): void {
    this.renderer.keyInput.off("keypress", this.onKey);
    this.resolve(result);
  }

  private syncSubmit(): void {
    const label = ` ${this.controller.spec.submitLabel ?? "Submit"} `;
    const focused = this.controller.focused().kind === "submit";
    this.submit.content = styled([focused ? bold(fg("#1f1f28")(label)) : fg(palette.accent)(`[${label}]`)]);
    this.submit.bg = focused ? palette.accent : undefined;
  }

  private syncFocus(): void {
    const focused = this.controller.focused();
    const editor = isEditing(focused) ? this.editorFor(focused) : undefined;
    for (const view of this.views.values()) {
      for (const candidate of editorsOf(view)) if (candidate !== editor) candidate.blur();
    }
    editor?.focus();
  }

  private scrollToFocus(): void {
    const focused = this.controller.focused();
    const id = focused.kind === "submit" ? "submit" : elementRootId(focused.element.id);
    this.scroll.scrollChildIntoView(id);
  }

  private overflows(): boolean {
    return this.scroll.scrollHeight > this.scroll.viewport.height;
  }

  private editorFor(focusable: Focusable): Editor | undefined {
    if (focusable.kind === "submit") return undefined;
    return this.views.get(focusable.element)?.editorFor(focusable);
  }

  private createView(element: Element): ElementView {
    switch (element.type) {
      case "note":
        return new NoteView(this.renderer, element.text);
      case "markdown":
        return new MarkdownView(this.renderer, element.text);
      case "image":
        return new ImageView(this.renderer, element, this.images);
      case "text":
        return new TextView(this.renderer, this.controller, element, this.changed);
      case "confirm":
        return new ConfirmView(this.renderer, this.controller, element, this.changed);
      case "number":
        return new NumberView(this.renderer, this.controller, element, this.changed);
      case "choice":
        return new ChoiceView(this.renderer, this.controller, element, this.changed);
    }
  }
}

function editorPosition(editor: Editor | undefined): EditorPosition | undefined {
  if (!editor) return undefined;
  const text = editor.plainText;
  const offset = editor.cursorOffset;
  return { onFirstLine: !text.slice(0, offset).includes("\n"), onLastLine: !text.slice(offset).includes("\n") };
}

function editorsOf(view: ElementView): Editor[] {
  if (view instanceof TextView) return [view.editor];
  if (view instanceof ChoiceView) return [view.other];
  return [];
}

function elementRootId(id: string): string {
  return `element-${id}`;
}

function renderHints(focused: Focusable, overflows: boolean): StyledText {
  const chunks: Part[] = [];
  const scrolling = overflows ? [{ keys: "PgUp/PgDn", action: "scroll" }] : [];
  [...keyHints(focused), ...scrolling].forEach((hint, index) => {
    if (index > 0) chunks.push(dim("  ·  "));
    chunks.push(bold(fg(palette.accent)(hint.keys)), fg(palette.muted)(` ${hint.action}`));
  });
  return styled(chunks);
}

class NoteView implements ElementView {
  readonly root: BoxRenderable;

  constructor(renderer: CliRenderer, text: string) {
    this.root = new BoxRenderable(renderer, { flexDirection: "column" });
    this.root.add(new TextRenderable(renderer, { content: text }));
  }

  sync(): void {}

  flush(): void {}

  editorFor(): undefined {
    return undefined;
  }
}

class MarkdownView implements ElementView {
  readonly root: BoxRenderable;

  constructor(renderer: CliRenderer, text: string) {
    this.root = new BoxRenderable(renderer, { flexDirection: "column" });
    this.root.add(new MarkdownRenderable(renderer, { content: text, syntaxStyle: markdownStyle(renderer), tableOptions: { widthMode: "content", cellPaddingX: 1 } }));
  }

  sync(): void {}

  flush(): void {}

  editorFor(): undefined {
    return undefined;
  }
}

const imageMargin = { cols: 5, rows: 8 };

class ImageView implements ElementView {
  readonly root: BoxRenderable;

  constructor(renderer: CliRenderer, element: ImageElement, images: ImageOutput) {
    this.root = new BoxRenderable(renderer, { flexDirection: "column" });
    const caption = element.caption ? fg(palette.muted)(element.caption) : undefined;
    const handled = images.enabled && this.showImage(renderer, element, images);
    if (handled) {
      if (caption) this.root.add(new TextRenderable(renderer, { content: styled([caption]) }));
      return;
    }
    const label: Part[] = [fg(palette.muted)("[image] "), ...(caption ? [caption, fg(palette.muted)(" · ")] : []), fg(palette.muted)(element.path)];
    this.root.add(new TextRenderable(renderer, { content: styled(label) }));
  }

  private showImage(renderer: CliRenderer, element: ImageElement, images: ImageOutput): boolean {
    let image;
    try {
      image = readImage(element.path);
    } catch (error) {
      this.root.add(new TextRenderable(renderer, { content: `Could not show ${element.path}: ${(error as Error).message}`, fg: palette.error }));
      return true;
    }
    const box = fitImage(image.info.width, image.info.height, renderer.width - imageMargin.cols, renderer.height - imageMargin.rows);
    const id = newImageId();
    images.write(uploadCommands(id, image, box));
    this.root.add(new TextRenderable(renderer, { content: placeholderLines(box).join("\n"), fg: imageIdColor(id), wrapMode: "none", height: box.rows, flexShrink: 0 }));
    return true;
  }

  sync(): void {}

  flush(): void {}

  editorFor(): undefined {
    return undefined;
  }
}

function markdownStyle(renderer: CliRenderer): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: {},
      conceal: { fg: palette.muted },
      "markup.heading": { fg: palette.accent, bold: true },
      "markup.heading.1": { fg: "#e6c384", bold: true, underline: true },
      "markup.heading.2": { fg: palette.accent, bold: true },
      "markup.heading.3": { fg: "#957fb8", bold: true },
      "markup.heading.4": { fg: "#957fb8" },
      "markup.heading.5": { fg: palette.muted, bold: true },
      "markup.heading.6": { fg: palette.muted },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: "#e6c384" },
      "markup.link": { fg: palette.accent, underline: true },
      "markup.link.label": { fg: palette.accent },
      "markup.link.url": { fg: palette.muted, underline: true },
      "markup.list": { fg: palette.selected },
      "markup.quote": { fg: palette.muted, italic: true },
      keyword: { fg: "#957fb8" },
      string: { fg: "#98bb6c" },
      comment: { fg: palette.muted, italic: true },
      number: { fg: "#d27e99" },
      function: { fg: "#7e9cd8" },
      type: { fg: "#7aa89f" },
    },
    renderer.nativeScene,
  );
}

abstract class InputView implements ElementView {
  readonly root: BoxRenderable;
  private readonly label: TextRenderable;
  private readonly error: TextRenderable;

  constructor(
    protected readonly renderer: CliRenderer,
    protected readonly controller: FormController,
    protected readonly element: TextElement | ConfirmElement | NumberElement | ChoiceElement,
    protected readonly changed: () => void,
  ) {
    this.root = new BoxRenderable(renderer, { id: elementRootId(element.id), flexDirection: "column" });
    this.label = new TextRenderable(renderer, {});
    this.error = new TextRenderable(renderer, { fg: palette.error });
    this.root.add(this.label);
  }

  protected finishLayout(): void {
    this.root.add(this.error);
  }

  sync(): void {
    const focused = this.controller.isFocused({ kind: "input", element: this.element }) || this.isOtherFocused();
    this.label.content = styled([
      focused ? fg(palette.accent)("› ") : "  ",
      focused ? bold(this.element.label) : this.element.label,
    ]);
    const error = this.controller.errors.get(this.element.id);
    this.error.content = error ? `  ${error}` : "";
    this.error.visible = error !== undefined;
    this.syncBody(focused);
  }

  protected isOtherFocused(): boolean {
    return false;
  }

  flush(): void {}

  protected abstract syncBody(focused: boolean): void;

  editorFor(_focusable: Focusable): Editor | undefined {
    return undefined;
  }
}

class TextView extends InputView {
  readonly editor: Editor;

  constructor(renderer: CliRenderer, controller: FormController, element: TextElement, changed: () => void) {
    super(renderer, controller, element, changed);
    const options = {
      placeholder: element.placeholder ?? "Type your answer",
      marginLeft: 2,
      focusedBackgroundColor: "#2a2a37",
      onContentChange: () => {
        controller.dispatch({ type: "setText", id: element.id, value: this.editor.plainText });
        changed();
      },
    };
    this.editor = element.multiline
      ? new TextareaRenderable(renderer, { ...options, initialValue: element.default ?? "", minHeight: 3, maxHeight: 10, wrapMode: "word" })
      : new InputRenderable(renderer, { ...options, value: element.default ?? "" });
    this.root.add(this.editor);
    this.finishLayout();
  }

  protected syncBody(): void {}

  override flush(): void {
    if (this.editor.plainText !== this.controller.text(this.element.id)) {
      this.controller.dispatch({ type: "setText", id: this.element.id, value: this.editor.plainText });
    }
  }

  override editorFor(): Editor {
    return this.editor;
  }
}

class ConfirmView extends InputView {
  private readonly body = new TextRenderable(this.renderer, {});

  constructor(renderer: CliRenderer, controller: FormController, element: ConfirmElement, changed: () => void) {
    super(renderer, controller, element, changed);
    this.root.add(this.body);
    this.finishLayout();
  }

  protected syncBody(focused: boolean): void {
    const yes = this.controller.confirm(this.element.id);
    this.body.content = styled(["  ", ...option("Yes", yes, focused), "   ", ...option("No", !yes, focused)]);
  }
}

function option(label: string, chosen: boolean, focused: boolean): Part[] {
  const marker = chosen ? fg(palette.selected)("●") : fg(palette.muted)("○");
  const text = chosen && focused ? bold(label) : chosen ? label : fg(palette.muted)(label);
  return [marker, " ", text];
}

class NumberView extends InputView {
  private readonly body = new TextRenderable(this.renderer, {});

  constructor(renderer: CliRenderer, controller: FormController, protected override readonly element: NumberElement, changed: () => void) {
    super(renderer, controller, element, changed);
    this.root.add(this.body);
    this.finishLayout();
  }

  protected syncBody(focused: boolean): void {
    const value = this.controller.number(this.element.id);
    const arrows = focused ? fg(palette.accent) : fg(palette.muted);
    this.body.content = styled([
      "  ",
      arrows("◀ "),
      bold(String(value)),
      arrows(" ▶"),
      fg(palette.muted)(`   ${this.element.min}–${this.element.max}`),
    ]);
  }
}

class ChoiceView extends InputView {
  readonly other: InputRenderable;
  private readonly rows = new TextRenderable(this.renderer, {});

  constructor(renderer: CliRenderer, controller: FormController, protected override readonly element: ChoiceElement, changed: () => void) {
    super(renderer, controller, element, changed);
    this.other = new InputRenderable(renderer, {
      placeholder: "Type your answer",
      marginLeft: 6,
      focusedBackgroundColor: "#2a2a37",
      onContentChange: () => {
        controller.dispatch({ type: "setOtherText", id: element.id, value: this.other.plainText });
        changed();
      },
    });
    this.root.add(this.rows);
    this.root.add(this.other);
    this.finishLayout();
  }

  protected override isOtherFocused(): boolean {
    return this.controller.isFocused({ kind: "other", element: this.element });
  }

  override flush(): void {
    if (this.other.plainText !== this.controller.choice(this.element.id).otherText) {
      this.controller.dispatch({ type: "setOtherText", id: this.element.id, value: this.other.plainText });
    }
  }

  protected syncBody(focused: boolean): void {
    const state = this.controller.choice(this.element.id);
    const lines: Part[] = [];
    this.controller.choiceRows(this.element).forEach((row, index) => {
      const chosen = row.isOther ? state.otherSelected : state.selected.has(row.option.value);
      const atCursor = focused && !this.isOtherFocused() && index === state.cursor;
      if (index > 0) lines.push("\n");
      lines.push(atCursor ? fg(palette.accent)("  › ") : "    ", marker(chosen, Boolean(this.element.multi)), " ");
      lines.push(atCursor ? bold(row.option.label) : row.option.label);
      if (row.option.description) lines.push("\n", fg(palette.muted)(`      ${row.option.description}`));
    });
    this.rows.content = styled(lines);
    this.other.visible = state.otherSelected;
  }

  override editorFor(focusable: Focusable): Editor | undefined {
    return focusable.kind === "other" ? this.other : undefined;
  }
}

function marker(chosen: boolean, multi: boolean): TextChunk {
  const glyph = multi ? (chosen ? "■" : "□") : chosen ? "●" : "○";
  return chosen ? fg(palette.selected)(glyph) : fg(palette.muted)(glyph);
}
