import { z } from "zod";
import { parseWhen, referencedIds, WhenSyntaxError } from "./when.ts";

const elementId = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "ids must start with a letter or underscore and contain only letters, digits, and underscores")
  .refine((id) => id !== "true" && id !== "false", "ids cannot be true or false");

const when = z
  .string()
  .describe('Show this element only when the expression holds, e.g. `deploy && selected(env, "prod")`. It may only reference elements that appear earlier in the form.')
  .optional();

const inputFields = {
  id: elementId.describe("Key for this element's answer in the result"),
  label: z.string().describe("Question or prompt shown to the user"),
  when,
};

export const textElement = z.object({
  type: z.literal("text"),
  ...inputFields,
  placeholder: z.string().optional(),
  default: z.string().optional(),
  multiline: z.boolean().optional().describe("Allow newlines; Tab moves to the next field"),
  required: z.boolean().optional(),
});

export const confirmElement = z.object({
  type: z.literal("confirm"),
  ...inputFields,
  default: z.boolean().optional(),
});

export const choiceOption = z.union([
  z.string(),
  z.object({
    value: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export const choiceElement = z.object({
  type: z.literal("choice"),
  ...inputFields,
  options: z.array(choiceOption).min(1),
  multi: z.boolean().optional().describe("Let the user pick any number of options; the answer is an array"),
  other: z.boolean().optional().describe("Add an \"Other\" option with a free-text answer. Defaults to true."),
  default: z.union([z.string(), z.array(z.string())]).optional(),
  required: z.boolean().optional().describe("Require a selection (single choice) or at least one (multi)"),
});

export const numberElement = z.object({
  type: z.literal("number"),
  ...inputFields,
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
  default: z.number().optional(),
});

export const noteElement = z.object({
  type: z.literal("note"),
  text: z.string().describe("Text shown to the user; not an input"),
  when,
});

export const element = z.discriminatedUnion("type", [
  textElement,
  confirmElement,
  choiceElement,
  numberElement,
  noteElement,
]);

export const formSpec = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    elements: z.array(element).min(1),
    submitLabel: z.string().optional(),
  })
  .superRefine(validateForm);

export type FormSpec = z.infer<typeof formSpec>;
export type Element = z.infer<typeof element>;
export type InputElement = Exclude<Element, { type: "note" }>;
export type TextElement = z.infer<typeof textElement>;
export type ConfirmElement = z.infer<typeof confirmElement>;
export type ChoiceElement = z.infer<typeof choiceElement>;
export type NumberElement = z.infer<typeof numberElement>;
export type ChoiceOption = { value: string; label: string; description?: string };

export function parseFormSpec(input: unknown): FormSpec {
  return formSpec.parse(input);
}

export function isInputElement(element: Element): element is InputElement {
  return element.type !== "note";
}

export function choiceOptions(element: ChoiceElement): ChoiceOption[] {
  return element.options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : { ...option, label: option.label ?? option.value },
  );
}

export function allowsOther(element: ChoiceElement): boolean {
  return element.other ?? true;
}

function validateForm(form: { elements: Element[] }, ctx: z.RefinementCtx): void {
  const earlierIds = new Set<string>();
  form.elements.forEach((element, index) => {
    const path = ["elements", index];
    if (element.when !== undefined) validateWhen(element.when, earlierIds, [...path, "when"], ctx);
    if (!isInputElement(element)) return;
    if (earlierIds.has(element.id)) ctx.addIssue({ code: "custom", path: [...path, "id"], message: `duplicate id ${element.id}` });
    earlierIds.add(element.id);
    if (element.type === "choice") validateChoice(element, path, ctx);
    if (element.type === "number") validateNumber(element, path, ctx);
  });
}

function validateWhen(source: string, earlierIds: Set<string>, path: (string | number)[], ctx: z.RefinementCtx): void {
  try {
    for (const id of referencedIds(parseWhen(source))) {
      if (!earlierIds.has(id)) ctx.addIssue({ code: "custom", path, message: `${id} is not an earlier element` });
    }
  } catch (error) {
    if (!(error instanceof WhenSyntaxError)) throw error;
    ctx.addIssue({ code: "custom", path, message: `invalid expression: ${error.message}` });
  }
}

function validateChoice(element: ChoiceElement, path: (string | number)[], ctx: z.RefinementCtx): void {
  const values = choiceOptions(element).map((option) => option.value);
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path: [...path, "options"], message: "option values must be unique" });
  }
  if (element.default === undefined) return;
  const defaults = Array.isArray(element.default) ? element.default : [element.default];
  if (Array.isArray(element.default) !== Boolean(element.multi)) {
    ctx.addIssue({ code: "custom", path: [...path, "default"], message: element.multi ? "multi choice default must be an array" : "single choice default must be a string" });
  }
  for (const value of defaults) {
    if (!values.includes(value)) ctx.addIssue({ code: "custom", path: [...path, "default"], message: `${value} is not an option` });
  }
}

function validateNumber(element: NumberElement, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (element.min > element.max) ctx.addIssue({ code: "custom", path: [...path, "max"], message: "max must be at least min" });
  if (element.default !== undefined && (element.default < element.min || element.default > element.max)) {
    ctx.addIssue({ code: "custom", path: [...path, "default"], message: "default must be between min and max" });
  }
}
