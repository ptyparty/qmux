import { describe, expect, test } from "bun:test";
import { imageInfo } from "@opentui/core";
import { fitImage, imageIdColor, placeholderLines, uploadCommands } from "./image.ts";
import { tinyPng } from "./test-images.ts";

describe("fitImage", () => {
  test("sizes a box near the image's own size", () => {
    expect(fitImage(400, 200, 100, 50)).toEqual({ cols: 40, rows: 10 });
  });

  test("shrinks to the space available, keeping the shape", () => {
    expect(fitImage(2000, 1000, 80, 50)).toEqual({ cols: 80, rows: 20 });
    expect(fitImage(1000, 2000, 80, 20)).toEqual({ cols: 20, rows: 20 });
  });

  test("never makes an empty box", () => {
    expect(fitImage(1, 1, 0, 0)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("placeholderLines", () => {
  test("marks each cell with its row and column", () => {
    expect(placeholderLines({ cols: 2, rows: 2 })).toEqual([
      "\u{10EEEE}\u0305\u0305\u{10EEEE}\u0305\u030D",
      "\u{10EEEE}\u030D\u0305\u{10EEEE}\u030D\u030D",
    ]);
  });
});

test("imageIdColor encodes the id as a colour", () => {
  expect(imageIdColor(0x01022a)).toBe("#01022a");
});

describe("uploadCommands", () => {
  test("sends a PNG as-is in chunks, then places it in the box", () => {
    const data = tinyPng(300, 300);
    const commands = uploadCommands(7, { data, info: imageInfo(data) }, { cols: 30, rows: 15 });
    const payload = commands.map((command) => command.match(/;([^\x1b]*)\x1b\\$/)![1]).join("");
    expect(Buffer.from(payload, "base64")).toEqual(Buffer.from(data));
    expect(commands[0]).toStartWith("\x1b_Ga=T,U=1,i=7,c=30,r=15,f=100,q=2,m=");
    expect(commands.slice(1).every((command) => command.startsWith("\x1b_Gq=2,m="))).toBe(true);
    expect(commands.at(-1)).toStartWith("\x1b_Gq=2,m=0;");
  });
});
