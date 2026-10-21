import type { Socket } from "bun";

export class SocketWriter {
  private readonly pending: Uint8Array[] = [];
  private ending = false;

  constructor(private readonly socket: Socket<unknown>) {}

  write(bytes: Uint8Array): void {
    if (this.pending.length > 0) {
      this.pending.push(bytes);
      return;
    }
    const written = this.socket.write(bytes);
    if (written < bytes.length) this.pending.push(bytes.subarray(Math.max(written, 0)));
  }

  flush(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      const written = this.socket.write(next);
      if (written < next.length) {
        this.pending[0] = next.subarray(Math.max(written, 0));
        return;
      }
      this.pending.shift();
    }
    if (this.ending) this.socket.end();
  }

  endWhenFlushed(): void {
    this.ending = true;
    if (this.pending.length === 0) this.socket.end();
  }
}
