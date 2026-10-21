import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class UnsafeDirectoryError extends Error {}

export function runtimeDir(): string {
  if (process.env.QMUX_STATE_DIR) return process.env.QMUX_STATE_DIR;
  const base = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `qmux-${process.getuid?.() ?? "user"}`);
  return join(base, "qmux");
}

export function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  if (uid === undefined) return path;
  const stats = statSync(path);
  if (stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new UnsafeDirectoryError(`${path} must be a directory owned by you with no group or other permissions (chmod 700)`);
  }
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) assertTrustedAncestor(dir, uid);
  return path;
}

function assertTrustedAncestor(dir: string, uid: number): void {
  const stats = statSync(dir);
  const ownedByOther = stats.uid !== uid && stats.uid !== 0;
  const writableByOthers = (stats.mode & 0o002) !== 0 && (stats.mode & 0o1000) === 0;
  if (ownedByOther || writableByOthers) {
    throw new UnsafeDirectoryError(`${dir} is controlled by another user, so files beneath it are not private`);
  }
}
