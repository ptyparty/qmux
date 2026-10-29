const maxPartial = 4096;

export class LineTail {
  private readonly decoder = new TextDecoder();
  private partial = "";
  private last = "";

  push(data: Uint8Array): boolean {
    const before = this.line;
    const lines = (this.partial + this.decoder.decode(data, { stream: true })).split("\n");
    this.partial = lines.pop()!;
    for (const line of lines) {
      const shown = visible(line);
      if (shown) this.last = shown;
    }
    const redrawn = this.partial.lastIndexOf("\r");
    if (redrawn > 0) this.partial = this.partial.slice(redrawn);
    if (this.partial.length > maxPartial) this.partial = this.partial.slice(-maxPartial);
    return this.line !== before;
  }

  get line(): string {
    return visible(this.partial) || this.last;
  }
}

function visible(line: string): string {
  const parts = Bun.stripANSI(line).split("\r");
  for (let index = parts.length - 1; index >= 0; index--) {
    const text = parts[index]!.trim();
    if (text) return text;
  }
  return "";
}
