import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Snapshots and Codex homes live in a private cache directory, not the system
 * temp directory. The Codex sandbox denies /tmp and $TMPDIR, and on Linux that
 * hides everything under them, including a workspace placed there; Codex also
 * refuses to create its sandbox helper inside a temporary directory.
 */
export function workRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const root = path.join(cache, "databuddy-setup-agent");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** A fresh owner-only directory under the work root. */
export function makeWorkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(workRoot(), prefix));
}
