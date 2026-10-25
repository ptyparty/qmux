import { imageInfo, NativeImage, type ImageInfo } from "@opentui/core";
import { readFileSync, writeSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { placeholderDiacritics } from "./kitty-diacritics.ts";

export type ImageBox = { cols: number; rows: number };
export type LoadedImage = { data: Uint8Array; info: ImageInfo };

const placeholder = "\u{10EEEE}";
const chunkSize = 4096;
const cellWidthPx = 10;
const cellHeightPx = 20;
const maxRawWidth = 2048;

export type ImageOutput = { enabled: boolean; write: (commands: string[]) => void };

export function terminalImageOutput(env: Record<string, string | undefined> = process.env): ImageOutput {
  return { enabled: env.QMUX_KITTY_GRAPHICS === "1", write: writeToTerminal };
}

export function newImageId(): number {
  return 1 + Math.floor(Math.random() * 0xfffffe);
}

export function fitImage(width: number, height: number, maxCols: number, maxRows: number): ImageBox {
  const limit = placeholderDiacritics.length;
  let cols = Math.max(1, Math.min(maxCols, limit, Math.ceil(width / cellWidthPx)));
  let rows = Math.max(1, Math.round((cols * height * cellWidthPx) / (width * cellHeightPx)));
  const rowLimit = Math.max(1, Math.min(maxRows, limit));
  if (rows > rowLimit) {
    rows = rowLimit;
    cols = Math.max(1, Math.min(cols, Math.round((rows * width * cellHeightPx) / (height * cellWidthPx))));
  }
  return { cols, rows };
}

export function placeholderLines(box: ImageBox): string[] {
  const lines: string[] = [];
  for (let row = 0; row < box.rows; row++) {
    let line = "";
    for (let col = 0; col < box.cols; col++) line += placeholder + String.fromCodePoint(placeholderDiacritics[row]!, placeholderDiacritics[col]!);
    lines.push(line);
  }
  return lines;
}

export function imageIdColor(id: number): string {
  return `#${id.toString(16).padStart(6, "0")}`;
}

export function uploadCommands(id: number, image: LoadedImage, box: ImageBox): string[] {
  const encoded = image.info.format === "png" ? { keys: "f=100", payload: image.data } : rawRgba(image.data, image.info.width);
  const base64 = Buffer.from(encoded.payload).toString("base64");
  const commands: string[] = [];
  for (let start = 0; start < base64.length || start === 0; start += chunkSize) {
    const chunk = base64.slice(start, start + chunkSize);
    const more = start + chunkSize < base64.length ? 1 : 0;
    const keys = start === 0 ? `a=T,U=1,i=${id},c=${box.cols},r=${box.rows},${encoded.keys},q=2,m=${more}` : `q=2,m=${more}`;
    commands.push(`\x1b_G${keys};${chunk}\x1b\\`);
  }
  return commands;
}

function rawRgba(data: Uint8Array, width: number): { keys: string; payload: Uint8Array } {
  const decoded = NativeImage.decode(data);
  const image = width > maxRawWidth ? decoded.resize({ width: maxRawWidth }) : decoded;
  const raw = image.raw("rgba8");
  const rowBytes = raw.width * 4;
  const pixels = new Uint8Array(rowBytes * raw.height);
  for (let row = 0; row < raw.height; row++) pixels.set(raw.data.subarray(row * raw.stride, row * raw.stride + rowBytes), row * rowBytes);
  const keys = `f=32,s=${raw.width},v=${raw.height},o=z`;
  if (image !== decoded) image.dispose();
  decoded.dispose();
  return { keys, payload: deflateSync(pixels) };
}

export function readImage(path: string): LoadedImage {
  const data = new Uint8Array(readFileSync(path));
  return { data, info: imageInfo(data) };
}

function writeToTerminal(commands: string[]): void {
  const bytes = Buffer.from(commands.join(""), "latin1");
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Bun.sleepSync(1);
    }
  }
}
