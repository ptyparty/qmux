import { dlopen, FFIType, ptr } from "bun:ffi";

declare const self: Worker;

const POLLIN = 0x1;
const POLLERR = 0x8;
const POLLHUP = 0x10;

const libc = dlopen("libc.so.6", {
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});

export type PollerSetup = { fds: SharedArrayBuffer; armed: SharedArrayBuffer; wakeFd: number };

self.onmessage = (event: MessageEvent<PollerSetup>) => {
  const fds = new Int32Array(event.data.fds);
  const armed = new Int32Array(event.data.armed);
  pollForever(fds, armed, event.data.wakeFd);
};

function pollForever(fds: Int32Array, armed: Int32Array, wakeFd: number): never {
  const pollfds = new DataView(new ArrayBuffer((fds.length + 1) * 8));
  const slots = new Int32Array(fds.length);
  const drain = new Uint8Array(256);
  for (;;) {
    let count = 0;
    addEntry(pollfds, count++, wakeFd);
    for (let slot = 0; slot < fds.length; slot++) {
      if (fds[slot]! < 0 || Atomics.load(armed, slot) !== 1) continue;
      slots[count - 1] = slot;
      addEntry(pollfds, count++, fds[slot]!);
    }
    if (libc.symbols.poll(ptr(pollfds), count, -1) <= 0) continue;
    if (pollfds.getInt16(6, true) & POLLIN) while (Number(libc.symbols.read(wakeFd, ptr(drain), drain.length)) > 0);
    for (let entry = 1; entry < count; entry++) {
      if ((pollfds.getInt16(entry * 8 + 6, true) & (POLLIN | POLLERR | POLLHUP)) === 0) continue;
      const slot = slots[entry - 1]!;
      Atomics.store(armed, slot, 0);
      self.postMessage(slot);
    }
  }
}

function addEntry(pollfds: DataView, index: number, fd: number): void {
  pollfds.setInt32(index * 8, fd, true);
  pollfds.setInt16(index * 8 + 4, POLLIN, true);
  pollfds.setInt16(index * 8 + 6, 0, true);
}
