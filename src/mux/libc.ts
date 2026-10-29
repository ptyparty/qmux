import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

const darwin = process.platform === "darwin";

export const libcPath = darwin ? "libSystem.B.dylib" : "libc.so.6";

export const TIOCSWINSZ = darwin ? 0x80087467 : 0x5414;
export const O_NONBLOCK = darwin ? 0x4 : 0o4000;
export const EAGAIN = darwin ? 35 : 11;

// Apple arm64 passes variadic arguments on the stack, so fill the argument
// registers to push the real argument there too.
const padding = darwin && process.arch === "arm64" ? 6 : 0;
const padTypes = Array<FFIType>(padding).fill(FFIType.u64);
const padValues = Array<number>(padding).fill(0);

const errnoLocation = darwin ? "__error" : "__errno_location";

const libc = dlopen(libcPath, {
  fcntl: { args: [FFIType.i32, FFIType.i32, ...padTypes, FFIType.i64], returns: FFIType.i32 },
  ioctl: { args: [FFIType.i32, FFIType.u64, ...padTypes, FFIType.ptr], returns: FFIType.i32 },
});

const errnoLib = dlopen(libcPath, { [errnoLocation]: { args: [], returns: FFIType.ptr } });

export function fcntl(fd: number, cmd: number, arg: number): number {
  return libc.symbols.fcntl(fd, cmd, ...padValues, arg);
}

export function ioctl(fd: number, request: number, arg: Pointer): number {
  return libc.symbols.ioctl(fd, request, ...padValues, arg);
}

export function errno(): number {
  return read.i32(errnoLib.symbols[errnoLocation]!()!, 0);
}
