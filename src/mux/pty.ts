import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, writeSync } from "node:fs";
import { EAGAIN, errno, fcntl, ioctl, libcPath, O_NONBLOCK, TIOCSWINSZ } from "./libc.ts";

const F_GETFL = 3;
const F_SETFL = 4;
const EINTR = 4;
const maxSlots = 512;
const readSize = 64 * 1024;
const writeRetryMs = 10;
const maxPendingInput = 1024 * 1024;

const libc = dlopen(libcPath, {
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});

function setNonBlocking(fd: number): void {
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
}

class Reactor {
  private readonly fds = new Int32Array(new SharedArrayBuffer(maxSlots * 4)).fill(-1);
  private readonly armed = new Int32Array(new SharedArrayBuffer(maxSlots * 4));
  private readonly handlers = new Map<number, () => void>();
  private readonly wakeWrite: number;
  private readonly worker: Worker;

  constructor() {
    const pipe = new Int32Array(2);
    if (libc.symbols.pipe(ptr(pipe)) !== 0) throw new Error("pipe failed");
    setNonBlocking(pipe[0]!);
    setNonBlocking(pipe[1]!);
    this.wakeWrite = pipe[1]!;
    this.worker = new Worker(new URL("./poller.worker.ts", import.meta.url).href);
    this.worker.onmessage = (event: MessageEvent<number>) => this.handlers.get(event.data)?.();
    this.worker.postMessage({ fds: this.fds.buffer, armed: this.armed.buffer, wakeFd: pipe[0]! });
    this.worker.unref();
  }

  watch(fd: number, onReadable: () => void): number {
    const slot = this.fds.indexOf(-1);
    if (slot < 0) throw new Error("too many ptys");
    this.handlers.set(slot, onReadable);
    Atomics.store(this.fds, slot, fd);
    return slot;
  }

  arm(slot: number): void {
    Atomics.store(this.armed, slot, 1);
    this.wake();
  }

  unwatch(slot: number): void {
    Atomics.store(this.armed, slot, 0);
    Atomics.store(this.fds, slot, -1);
    this.handlers.delete(slot);
    this.wake();
  }

  private wake(): void {
    try {
      writeSync(this.wakeWrite, new Uint8Array([1]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

let reactor: Reactor | undefined;

export class ReadScheduler {
  private readonly queue: Pty[] = [];
  private readonly queued = new Set<Pty>();
  private priority: Pty | undefined;
  private windowStart = performance.now();
  private spentMs = 0;
  private pumpScheduled = false;

  constructor(
    private readonly budgetMs: number,
    private readonly windowMs: number,
  ) {}

  setPriority(pty: Pty | undefined): void {
    this.priority = pty;
  }

  readable(pty: Pty): void {
    if (pty === this.priority) return this.readPriority(pty);
    if (!this.queued.has(pty)) {
      this.queued.add(pty);
      this.queue.push(pty);
    }
    this.schedulePump(0);
  }

  private readPriority(pty: Pty): void {
    const deadline = performance.now() + this.budgetMs;
    for (;;) {
      const result = pty.readOnce();
      if (result === "empty") return pty.arm();
      if (result === "closed") return;
      if (performance.now() >= deadline) {
        this.queued.add(pty);
        this.queue.push(pty);
        return this.schedulePump(0);
      }
    }
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pump();
    }, delayMs);
  }

  private pump(): void {
    const now = performance.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.spentMs = 0;
    }
    while (this.queue.length > 0 && this.spentMs < this.budgetMs) {
      const pty = this.queue.shift()!;
      const started = performance.now();
      const result = pty.readOnce();
      this.spentMs += performance.now() - started;
      if (result === "data") this.queue.push(pty);
      else {
        this.queued.delete(pty);
        if (result === "empty") pty.arm();
      }
    }
    if (this.queue.length > 0) this.schedulePump(Math.max(this.windowStart + this.windowMs - performance.now(), 0));
  }
}

export type PtyOptions = {
  command: string[];
  cols: number;
  rows: number;
  scheduler: ReadScheduler;
  onData: (data: Uint8Array) => void;
  onExit?: () => void;
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export class Pty {
  readonly child: Bun.Subprocess;
  private readonly master: number;
  private readonly slot: number;
  private readonly buffer = new Uint8Array(readSize);
  private closed = false;
  private pendingInput: Uint8Array[] = [];
  private pendingBytes = 0;
  private retryTimer: Timer | undefined;

  constructor(private readonly options: PtyOptions) {
    reactor ??= new Reactor();
    const fds = new Int32Array(2);
    if (libc.symbols.openpty(ptr(fds), ptr(fds, 4), null, null, null) !== 0) throw new Error("openpty failed");
    const [master, slave] = [fds[0]!, fds[1]!];
    this.master = master;
    setNonBlocking(master);
    this.resize(options.cols, options.rows);
    this.child = Bun.spawn(["setsid", "--ctty", ...options.command], {
      stdio: [slave, slave, slave],
      env: options.env,
      cwd: options.cwd,
    });
    closeSync(slave);
    this.slot = reactor.watch(master, () => options.scheduler.readable(this));
    reactor.arm(this.slot);
  }

  write(data: string | Uint8Array): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : Uint8Array.from(data);
    if (this.pendingBytes + bytes.length > maxPendingInput) return;
    this.pendingInput.push(bytes);
    this.pendingBytes += bytes.length;
    this.flushInput();
  }

  private flushInput(): void {
    this.retryTimer = undefined;
    while (this.pendingInput.length > 0 && !this.closed) {
      const next = this.pendingInput[0]!;
      let written: number;
      try {
        written = writeSync(this.master, next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") {
          this.retryTimer ??= setTimeout(() => this.flushInput(), writeRetryMs);
          return;
        }
        if (code === "EIO") return;
        throw error;
      }
      this.pendingBytes -= written;
      if (written < next.length) this.pendingInput[0] = next.subarray(written);
      else this.pendingInput.shift();
    }
  }

  resize(cols: number, rows: number, width = 0, height = 0): void {
    const size = new Uint16Array([rows, cols, width, height]);
    ioctl(this.master, TIOCSWINSZ, ptr(size));
  }

  kill(): void {
    this.child.kill();
    this.close();
  }

  readOnce(): "data" | "empty" | "closed" {
    if (this.closed) return "closed";
    for (;;) {
      const count = Number(libc.symbols.read(this.master, ptr(this.buffer), this.buffer.length));
      if (count > 0) {
        this.options.onData(this.buffer.subarray(0, count));
        return "data";
      }
      if (count < 0 && errno() === EINTR) continue;
      if (count < 0 && errno() === EAGAIN) return "empty";
      this.close();
      this.options.onExit?.();
      return "closed";
    }
  }

  arm(): void {
    if (!this.closed) reactor!.arm(this.slot);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.pendingInput = [];
    reactor!.unwatch(this.slot);
    closeSync(this.master);
  }
}
