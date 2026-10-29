import {
  allowsOther,
  choiceOptions,
  isInputElement,
  type ChoiceElement,
  type ChoiceOption,
  type Element,
  type FormSpec,
  type InputElement,
  type NumberElement,
  type SlidesElement,
} from "./schema.ts";
import { evaluateWhen, parseWhen, type Expr } from "./when.ts";

export type Answer = string | number | boolean | string[] | null;

export type FormResult =
  | { status: "submitted"; values: Record<string, Answer> }
  | { status: "cancelled" };

export type Focusable =
  | { kind: "input"; element: InputElement }
  | { kind: "other"; element: ChoiceElement }
  | { kind: "note"; element: SlidesElement }
  | { kind: "submit" };

export type FormAction =
  | { type: "next" }
  | { type: "previous" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "toggle" }
  | { type: "activate" }
  | { type: "setText"; id: string; value: string }
  | { type: "setOtherText"; id: string; value: string }
  | { type: "setNote"; id: string; value: string }
  | { type: "submit" }
  | { type: "cancel" };

export type ChoiceState = {
  cursor: number;
  selected: Set<string>;
  otherSelected: boolean;
  otherText: string;
};

export type SlidesState = { index: number; notes: string[] };

export type ChoiceRow = { option: ChoiceOption; isOther: boolean };

const otherOption: ChoiceOption = { value: "", label: "Other…" };

export class FormController {
  readonly spec: FormSpec;
  result: FormResult | null = null;
  errors = new Map<string, string>();

  private readonly conditions = new Map<Element, Expr>();
  private readonly texts = new Map<string, string>();
  private readonly confirms = new Map<string, boolean>();
  private readonly numbers = new Map<string, number>();
  private readonly choices = new Map<string, ChoiceState>();
  private readonly slideshows = new Map<string, SlidesState>();
  private focusKey: string;

  constructor(spec: FormSpec) {
    this.spec = spec;
    for (const element of spec.elements) {
      if (element.when !== undefined) this.conditions.set(element, parseWhen(element.when));
      if (isInputElement(element)) this.initialize(element);
    }
    this.focusKey = focusKeyOf(this.focusables()[0] ?? { kind: "submit" });
  }

  visibleElements(): Element[] {
    const visible = new Set<string>();
    return this.spec.elements.filter((element) => {
      const condition = this.conditions.get(element);
      const shown = condition === undefined || evaluateWhen(condition, (id) => (visible.has(id) ? this.conditionValue(id) : undefined));
      if (shown && isInputElement(element)) visible.add(element.id);
      return shown;
    });
  }

  focusables(): Focusable[] {
    const focusables: Focusable[] = [];
    for (const element of this.visibleElements()) {
      if (!isInputElement(element)) continue;
      focusables.push({ kind: "input", element });
      if (element.type === "choice" && this.choice(element.id).otherSelected) focusables.push({ kind: "other", element });
      if (element.type === "slides" && takesNotes(element)) focusables.push({ kind: "note", element });
    }
    focusables.push({ kind: "submit" });
    return focusables;
  }

  focused(): Focusable {
    const focusables = this.focusables();
    return focusables.find((focusable) => focusKeyOf(focusable) === this.focusKey) ?? focusables[focusables.length - 1]!;
  }

  isFocused(focusable: Focusable): boolean {
    return focusKeyOf(this.focused()) === focusKeyOf(focusable);
  }

  text(id: string): string {
    return this.texts.get(id) ?? "";
  }

  confirm(id: string): boolean {
    return this.confirms.get(id) ?? false;
  }

  number(id: string): number {
    return this.numbers.get(id) ?? 0;
  }

  choice(id: string): ChoiceState {
    const state = this.choices.get(id);
    if (!state) throw new Error(`no choice element ${id}`);
    return state;
  }

  slides(id: string): SlidesState {
    const state = this.slideshows.get(id);
    if (!state) throw new Error(`no slides element ${id}`);
    return state;
  }

  choiceRows(element: ChoiceElement): ChoiceRow[] {
    const rows: ChoiceRow[] = choiceOptions(element).map((option) => ({ option, isOther: false }));
    if (allowsOther(element)) rows.push({ option: otherOption, isOther: true });
    return rows;
  }

  answer(id: string): Answer {
    const element = this.spec.elements.find((candidate) => isInputElement(candidate) && candidate.id === id);
    if (!element || !isInputElement(element)) return null;
    switch (element.type) {
      case "text":
        return this.text(id);
      case "confirm":
        return this.confirm(id);
      case "number":
        return this.number(id);
      case "choice":
        return this.choiceAnswer(element);
      case "slides":
        return takesNotes(element) ? [...this.slides(id).notes] : null;
    }
  }

  private conditionValue(id: string): Answer {
    const answer = this.answer(id);
    return this.slideshows.has(id) && Array.isArray(answer) ? answer.filter((note) => note !== "") : answer;
  }

  dispatch(action: FormAction): void {
    if (this.result) return;
    switch (action.type) {
      case "next":
        return this.moveFocus(1);
      case "previous":
        return this.moveFocus(-1);
      case "up":
        return this.vertical(-1);
      case "down":
        return this.vertical(1);
      case "left":
        return this.horizontal(-1);
      case "right":
        return this.horizontal(1);
      case "toggle":
        return this.toggle();
      case "activate":
        return this.activate();
      case "setText":
        this.texts.set(action.id, action.value);
        this.errors.delete(action.id);
        return;
      case "setOtherText":
        this.choice(action.id).otherText = action.value;
        this.errors.delete(action.id);
        return;
      case "setNote": {
        const state = this.slides(action.id);
        state.notes[state.index] = action.value;
        return;
      }
      case "submit":
        return this.submit();
      case "cancel":
        this.result = { status: "cancelled" };
        return;
    }
  }

  private initialize(element: InputElement): void {
    switch (element.type) {
      case "text":
        this.texts.set(element.id, element.default ?? "");
        return;
      case "confirm":
        this.confirms.set(element.id, element.default ?? false);
        return;
      case "number":
        this.numbers.set(element.id, element.default ?? element.min);
        return;
      case "choice":
        this.choices.set(element.id, initialChoiceState(element));
        return;
      case "slides":
        this.slideshows.set(element.id, { index: 0, notes: element.slides.map(() => "") });
        return;
    }
  }

  private choiceAnswer(element: ChoiceElement): Answer {
    const state = this.choice(element.id);
    const picked = choiceOptions(element)
      .map((option) => option.value)
      .filter((value) => state.selected.has(value));
    if (element.multi) return state.otherSelected && state.otherText !== "" ? [...picked, state.otherText] : picked;
    if (state.otherSelected) return state.otherText;
    return picked[0] ?? null;
  }

  private moveFocus(delta: number): void {
    const focusables = this.focusables();
    const index = focusables.findIndex((focusable) => focusKeyOf(focusable) === focusKeyOf(this.focused()));
    const target = focusables[Math.min(Math.max(index + delta, 0), focusables.length - 1)];
    if (target) this.focusKey = focusKeyOf(target);
  }

  private vertical(delta: number): void {
    const focused = this.focused();
    if (focused.kind !== "input" || focused.element.type !== "choice") return this.moveFocus(delta);
    const state = this.choice(focused.element.id);
    const cursor = state.cursor + delta;
    if (cursor < 0 || cursor >= this.choiceRows(focused.element).length) return this.moveFocus(delta);
    state.cursor = cursor;
    if (!focused.element.multi) this.selectAtCursor(focused.element);
  }

  private horizontal(delta: number): void {
    const focused = this.focused();
    if (focused.kind !== "input") return;
    if (focused.element.type === "confirm") this.confirms.set(focused.element.id, delta < 0);
    if (focused.element.type === "number") this.stepNumber(focused.element, delta);
    if (focused.element.type === "slides") {
      const state = this.slides(focused.element.id);
      state.index = Math.min(Math.max(state.index + delta, 0), focused.element.slides.length - 1);
    }
  }

  private stepNumber(element: NumberElement, delta: number): void {
    const step = element.step ?? 1;
    const precision = Math.max(decimalPlaces(step), decimalPlaces(element.min));
    const next = Number((this.number(element.id) + delta * step).toFixed(precision));
    this.numbers.set(element.id, Math.min(Math.max(next, element.min), element.max));
  }

  private toggle(): void {
    const focused = this.focused();
    if (focused.kind !== "input") return;
    if (focused.element.type === "confirm") this.confirms.set(focused.element.id, !this.confirm(focused.element.id));
    if (focused.element.type === "choice") this.toggleAtCursor(focused.element);
  }

  private activate(): void {
    const focused = this.focused();
    if (focused.kind === "submit") return this.submit();
    if (focused.kind === "input" && focused.element.type === "choice" && !focused.element.multi) {
      this.selectAtCursor(focused.element);
    }
    this.moveFocus(1);
  }

  private selectAtCursor(element: ChoiceElement): void {
    const state = this.choice(element.id);
    const row = this.choiceRows(element)[state.cursor];
    if (!row) return;
    state.selected = row.isOther ? new Set() : new Set([row.option.value]);
    state.otherSelected = row.isOther;
    this.errors.delete(element.id);
  }

  private toggleAtCursor(element: ChoiceElement): void {
    if (!element.multi) return this.selectAtCursor(element);
    const state = this.choice(element.id);
    const row = this.choiceRows(element)[state.cursor];
    if (!row) return;
    if (row.isOther) state.otherSelected = !state.otherSelected;
    else if (state.selected.has(row.option.value)) state.selected.delete(row.option.value);
    else state.selected.add(row.option.value);
    this.errors.delete(element.id);
  }

  private submit(): void {
    this.errors = this.validate();
    const firstError = this.focusables().find((focusable) => focusable.kind !== "submit" && this.errors.has(focusable.element.id));
    if (firstError) {
      this.focusKey = focusKeyOf(firstError);
      return;
    }
    const values: Record<string, Answer> = {};
    for (const element of this.visibleElements()) {
      if (isInputElement(element)) values[element.id] = this.answer(element.id);
    }
    this.result = { status: "submitted", values };
  }

  private validate(): Map<string, string> {
    const errors = new Map<string, string>();
    for (const element of this.visibleElements()) {
      if (!isInputElement(element)) continue;
      const error = this.validationError(element);
      if (error) errors.set(element.id, error);
    }
    return errors;
  }

  private validationError(element: InputElement): string | undefined {
    if (element.type === "text" && element.required && this.text(element.id).trim() === "") return "This field is required";
    if (element.type !== "choice") return undefined;
    const state = this.choice(element.id);
    if (state.otherSelected && state.otherText.trim() === "") return "Enter a value for Other";
    const answer = this.choiceAnswer(element);
    const empty = answer === null || (Array.isArray(answer) && answer.length === 0);
    if (element.required && empty) return element.multi ? "Select at least one option" : "Select an option";
    return undefined;
  }
}

export function takesNotes(element: SlidesElement): boolean {
  return element.notes ?? true;
}

function initialChoiceState(element: ChoiceElement): ChoiceState {
  const defaults = element.default === undefined ? [] : Array.isArray(element.default) ? element.default : [element.default];
  const firstDefault = choiceOptions(element).findIndex((option) => defaults.includes(option.value));
  return { cursor: Math.max(firstDefault, 0), selected: new Set(defaults), otherSelected: false, otherText: "" };
}

function decimalPlaces(value: number): number {
  const [, fraction = ""] = String(value).split(".");
  return fraction.length;
}

function focusKeyOf(focusable: Focusable): string {
  return focusable.kind === "submit" ? "submit" : `${focusable.kind}:${focusable.element.id}`;
}
