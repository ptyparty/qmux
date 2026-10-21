import { StyledText, type TextChunk } from "@opentui/core";

export type Part = string | TextChunk;

export function styled(parts: Part[]): StyledText {
  return new StyledText(parts.map((part) => (typeof part === "string" ? { __isChunk: true, text: part } : part)));
}
