import { rmSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../private-dir.ts";

export class TabDirs {
  constructor(private readonly root: string) {
    rmSync(root, { recursive: true, force: true });
  }

  tabDir(tabId: number): string {
    return ensurePrivateDir(join(this.root, String(tabId)));
  }

  remove(tabId: number): void {
    rmSync(join(this.root, String(tabId)), { recursive: true, force: true });
  }
}
