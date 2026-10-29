import { dlopen, FFIType } from "bun:ffi";
import { openSync } from "node:fs";
import { libcPath } from "../libc.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;

const libc = dlopen(libcPath, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export function tryLock(path: string): boolean {
  const fd = openSync(path, "a", 0o600);
  return libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}
