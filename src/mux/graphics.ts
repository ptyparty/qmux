import type { PaneId } from "./layout.ts";

export type GraphicsCommand = {
  text: string;
  imageId: number | undefined;
  continuation: boolean;
  transmits: boolean;
  deletes: Deletion | undefined;
};

export type Deletion = { images: number | "all"; freesData: boolean };

const command = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g;
const commandStart = "\x1b_G";
const unfinished = /^\x1b_G[^\x1b]*\x1b?$/;
const maxPendingLength = 1024 * 1024;

export class GraphicsScanner {
  private tail = "";
  private chunking: "forward" | "drop" | undefined;

  scan(data: Uint8Array): GraphicsCommand[] {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (this.tail === "" && bytes.indexOf(commandStart, 0, "latin1") < 0 && bytes.at(-1) !== 0x1b && !endsWith(bytes, "\x1b_")) return [];
    const text = this.tail + bytes.toString("latin1");
    const commands: GraphicsCommand[] = [];
    let scanned = 0;
    for (const match of text.matchAll(command)) {
      scanned = match.index! + match[0].length;
      const forwarded = this.accept(parseKeys(match[1]!), match[2]);
      if (forwarded) commands.push(forwarded);
    }
    const pending = text.lastIndexOf(commandStart);
    if (pending >= scanned && text.length - pending <= maxPendingLength && unfinished.test(text.slice(pending))) this.tail = text.slice(pending);
    else this.tail = text.endsWith("\x1b_") ? "\x1b_" : text.endsWith("\x1b") ? "\x1b" : "";
    return commands;
  }

  private accept(keys: Map<string, string>, payload: string | undefined): GraphicsCommand | undefined {
    const more = keys.get("m") === "1";
    if (this.chunking) {
      const forward = this.chunking === "forward";
      if (!more) this.chunking = undefined;
      return forward ? { text: encode(keys, payload), imageId: undefined, continuation: true, transmits: false, deletes: undefined } : undefined;
    }
    const action = keys.get("a") ?? "t";
    const imageId = keys.has("i") ? Number(keys.get("i")) : undefined;
    const deletes = action === "d" ? deletion(keys, imageId) : undefined;
    const forward = action !== "q" && ((action !== "T" && action !== "p") || keys.get("U") === "1") && (action !== "d" || deletes !== undefined);
    if (more) this.chunking = forward ? "forward" : "drop";
    if (!forward) return undefined;
    return {
      text: encode(keys, payload),
      imageId,
      continuation: false,
      transmits: action === "t" || action === "T",
      deletes,
    };
  }
}

function endsWith(bytes: Buffer, suffix: string): boolean {
  return bytes.length >= suffix.length && bytes.toString("latin1", bytes.length - suffix.length) === suffix;
}

function parseKeys(control: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of control.split(",")) {
    const separator = pair.indexOf("=");
    if (separator > 0) keys.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return keys;
}

function encode(keys: Map<string, string>, payload: string | undefined): string {
  const quiet = new Map(keys).set("q", "2");
  const control = [...quiet].map(([key, value]) => `${key}=${value}`).join(",");
  return `\x1b_G${control}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
}

function deletion(keys: Map<string, string>, imageId: number | undefined): Deletion | undefined {
  const target = keys.get("d") ?? "a";
  const freesData = target === target.toUpperCase();
  if (target.toLowerCase() === "a") return { images: "all", freesData };
  if (target.toLowerCase() === "i" && imageId !== undefined) return { images: imageId, freesData };
  return undefined;
}

type Transfer = { imageId: number | undefined; parts: Uint8Array[]; size: number };

export class GraphicsRelay {
  private readonly transfers = new Map<PaneId, Transfer[]>();
  private stored = 0;

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly maxStoredBytes = 64 * 1024 * 1024,
  ) {}

  forward(paneId: PaneId, command: GraphicsCommand): void {
    if (command.deletes?.images === "all") return this.deleteAll(paneId, command.deletes.freesData);
    const bytes = Buffer.from(command.text, "latin1");
    this.send(bytes);
    if (command.deletes) {
      if (command.deletes.freesData) this.drop(paneId, command.deletes.images);
      return;
    }
    if (command.transmits && command.imageId !== undefined) this.drop(paneId, command.imageId);
    const transfers = this.transfers.get(paneId) ?? [];
    if (command.continuation) {
      const last = transfers.at(-1);
      if (!last) return;
      last.parts.push(bytes);
      last.size += bytes.length;
    } else {
      transfers.push({ imageId: command.imageId, parts: [bytes], size: bytes.length });
    }
    this.transfers.set(paneId, transfers);
    this.stored += bytes.length;
    this.evict();
  }

  forgetPane(paneId: PaneId): void {
    this.deleteAll(paneId, true);
  }

  replay(): Uint8Array[] {
    return [...this.transfers.values()].flatMap((transfers) => transfers.flatMap((transfer) => transfer.parts));
  }

  private deleteAll(paneId: PaneId, freesData: boolean): void {
    const transfers = this.transfers.get(paneId) ?? [];
    const ids = new Set(transfers.flatMap((transfer) => (transfer.imageId === undefined ? [] : [transfer.imageId])));
    for (const id of ids) this.send(Buffer.from(`\x1b_Ga=d,d=${freesData ? "I" : "i"},i=${id},q=2\x1b\\`, "latin1"));
    if (freesData) this.drop(paneId, "all");
  }

  private drop(paneId: PaneId, which: number | "all"): void {
    const transfers = this.transfers.get(paneId) ?? [];
    const kept = transfers.filter((transfer) => which !== "all" && transfer.imageId !== which);
    for (const transfer of transfers) if (!kept.includes(transfer)) this.stored -= transfer.size;
    if (kept.length === 0) this.transfers.delete(paneId);
    else this.transfers.set(paneId, kept);
  }

  private evict(): void {
    while (this.stored > this.maxStoredBytes) {
      const [paneId, transfers] = this.transfers.entries().next().value!;
      const oldest = transfers.shift()!;
      this.stored -= oldest.size;
      if (transfers.length === 0) this.transfers.delete(paneId);
    }
  }
}
