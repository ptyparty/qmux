import { describe, expect, test } from "bun:test";
import { GraphicsRelay, GraphicsScanner, type GraphicsCommand } from "./graphics.ts";

const bytes = (text: string) => Buffer.from(text, "latin1");
const apc = (control: string, payload?: string) => `\x1b_G${control}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
const texts = (commands: GraphicsCommand[]) => commands.map((command) => command.text);

describe("GraphicsScanner", () => {
  test("forwards transmissions and virtual placements with replies silenced", () => {
    const scanner = new GraphicsScanner();
    const commands = scanner.scan(bytes(`hi${apc("a=T,U=1,i=7,f=100,q=1", "AAAA")}there${apc("a=t,i=8", "BBBB")}`));
    expect(texts(commands)).toEqual([apc("a=T,U=1,i=7,f=100,q=2", "AAAA"), apc("a=t,i=8,q=2", "BBBB")]);
    expect(commands.map((command) => command.imageId)).toEqual([7, 8]);
  });

  test("drops queries and placements at the cursor", () => {
    const scanner = new GraphicsScanner();
    expect(scanner.scan(bytes(apc("a=q,i=31,s=1,v=1", "AAAA")))).toEqual([]);
    expect(scanner.scan(bytes(apc("a=T,i=2,f=100", "AAAA")))).toEqual([]);
    expect(scanner.scan(bytes(apc("a=p,i=2")))).toEqual([]);
  });

  test("follows a chunked transfer to its last chunk", () => {
    const scanner = new GraphicsScanner();
    const commands = scanner.scan(bytes(`${apc("a=T,U=1,i=3,m=1", "AA")}${apc("m=1", "BB")}${apc("m=0", "CC")}`));
    expect(texts(commands)).toEqual([apc("a=T,U=1,i=3,m=1,q=2", "AA"), apc("m=1,q=2", "BB"), apc("m=0,q=2", "CC")]);
    expect(commands.map((command) => command.continuation)).toEqual([false, true, true]);
    expect(scanner.scan(bytes(`${apc("a=T,i=4,m=1", "AA")}${apc("m=0", "BB")}`))).toEqual([]);
    expect(texts(scanner.scan(bytes(apc("a=t,i=5", "AA"))))).toEqual([apc("a=t,i=5,q=2", "AA")]);
  });

  test("reads a command split across reads", () => {
    const scanner = new GraphicsScanner();
    const whole = apc("a=t,i=9", "QUJDRA==");
    expect(scanner.scan(bytes(`text${whole.slice(0, 1)}`))).toEqual([]);
    expect(scanner.scan(bytes(whole.slice(1, 12)))).toEqual([]);
    expect(scanner.scan(bytes(whole.slice(12, -1)))).toEqual([]);
    expect(texts(scanner.scan(bytes(`${whole.slice(-1)}more`)))).toEqual([apc("a=t,i=9,q=2", "QUJDRA==")]);
  });

  test("says which images a delete covers", () => {
    const scanner = new GraphicsScanner();
    const [one, all, placements, bare] = scanner.scan(bytes(`${apc("a=d,d=I,i=4")}${apc("a=d,d=A")}${apc("a=d,d=a")}${apc("a=d")}`));
    expect(one!.deletes).toEqual({ images: 4, freesData: true });
    expect(all!.deletes).toEqual({ images: "all", freesData: true });
    expect(placements!.deletes).toEqual({ images: "all", freesData: false });
    expect(bare!.deletes).toEqual({ images: "all", freesData: false });
  });

  test("drops deletes by screen position", () => {
    const scanner = new GraphicsScanner();
    expect(scanner.scan(bytes(`${apc("a=d,d=C")}${apc("a=d,d=p,x=1,y=1")}${apc("a=d,d=z,z=0")}`))).toEqual([]);
  });
});

describe("GraphicsRelay", () => {
  const scanned = (text: string) => new GraphicsScanner().scan(bytes(text));
  const relayWith = () => {
    const sent: string[] = [];
    const relay = new GraphicsRelay((data) => sent.push(Buffer.from(data).toString("latin1")));
    return { relay, sent };
  };
  const replayed = (relay: GraphicsRelay) => relay.replay().map((data) => Buffer.from(data).toString("latin1"));

  test("sends commands on and replays transfers for terminals that attach later", () => {
    const { relay, sent } = relayWith();
    const scanner = new GraphicsScanner();
    for (const command of scanner.scan(bytes(`${apc("a=T,U=1,i=1,m=1", "AA")}${apc("m=0", "BB")}`))) relay.forward(1, command);
    expect(sent).toEqual([apc("a=T,U=1,i=1,m=1,q=2", "AA"), apc("m=0,q=2", "BB")]);
    expect(replayed(relay)).toEqual(sent);
  });

  test("replays only the latest upload of an image", () => {
    const { relay } = relayWith();
    for (const command of scanned(`${apc("a=t,i=1", "OLD")}${apc("a=t,i=1", "NEW")}`)) relay.forward(1, command);
    expect(replayed(relay)).toEqual([apc("a=t,i=1,q=2", "NEW")]);
  });

  test("deletes a closed pane's images", () => {
    const { relay, sent } = relayWith();
    for (const command of scanned(apc("a=t,i=5", "AA"))) relay.forward(2, command);
    relay.forgetPane(2);
    expect(sent.at(-1)).toBe(apc("a=d,d=I,i=5,q=2"));
    expect(relay.replay()).toEqual([]);
  });

  test("limits a pane's delete-all to that pane's own images", () => {
    const { relay, sent } = relayWith();
    for (const command of scanned(apc("a=t,i=7", "CC"))) relay.forward(3, command);
    for (const command of scanned(`${apc("a=t,i=5", "AA")}${apc("a=t,i=6", "BB")}`)) relay.forward(2, command);
    sent.length = 0;
    for (const command of scanned(apc("a=d,d=A"))) relay.forward(2, command);
    expect(sent).toEqual([apc("a=d,d=I,i=5,q=2"), apc("a=d,d=I,i=6,q=2")]);
    expect(replayed(relay)).toEqual([apc("a=t,i=7,q=2", "CC")]);
  });

  test("keeps images whose placements alone were deleted", () => {
    const { relay, sent } = relayWith();
    for (const command of scanned(`${apc("a=t,i=5", "AA")}${apc("a=d")}`)) relay.forward(2, command);
    expect(sent.at(-1)).toBe(apc("a=d,d=i,i=5,q=2"));
    expect(replayed(relay)).toEqual([apc("a=t,i=5,q=2", "AA")]);
  });

  test("forgets images the pane deleted", () => {
    const { relay } = relayWith();
    for (const command of scanned(`${apc("a=t,i=5", "AA")}${apc("a=t,i=6", "BB")}${apc("a=d,d=I,i=5")}`)) relay.forward(2, command);
    expect(replayed(relay)).toEqual([apc("a=t,i=6,q=2", "BB")]);
  });

  test("keeps the newest transfers within its budget", () => {
    const sent: Uint8Array[] = [];
    const relay = new GraphicsRelay((data) => sent.push(data), 40);
    for (const command of scanned(`${apc("a=t,i=1", "A".repeat(16))}${apc("a=t,i=2", "B".repeat(16))}`)) relay.forward(1, command);
    expect(replayed(relay)).toEqual([apc("a=t,i=2,q=2", "B".repeat(16))]);
  });
});
