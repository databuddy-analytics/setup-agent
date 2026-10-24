import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Snapshots and Codex homes live in a private cache directory, not the system
 * temp directory. The Codex sandbox denies /tmp and $TMPDIR, and on Linux that
 * hides everything under them, including a workspace placed there; Codex also
 * refuses to create its sandbox helper inside a temporary directory.
 */
function workRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const root = path.join(cache, "databuddy-setup-agent");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const STALE_MS = 24 * 60 * 60 * 1000;

// A run killed with SIGKILL cannot remove its snapshot or Codex home (which
// links to the user's Codex login). No run lasts a day, so anything older is
// a leftover.
function removeStale(root: string): void {
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (Date.now() - fs.lstatSync(dir).mtimeMs > STALE_MS)
        fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Best effort: a sweep failure must never block a run.
  }
}

/** A fresh owner-only directory under the work root. */
export function makeWorkDir(prefix: string): string {
  const root = workRoot();
  removeStale(root);
  return fs.mkdtempSync(path.join(root, prefix));
}
