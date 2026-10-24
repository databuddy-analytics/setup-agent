import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every fixture is created with os.tmpdir(), which honours TMPDIR, so giving
// each run its own TMPDIR lets one teardown remove everything the tests made.
export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-tests-"));
  process.env.TMPDIR = root;
  // Snapshots and Codex homes go under XDG_CACHE_HOME (see src/workdir.ts).
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  // Tests use synthetic website IDs; never send their run reports to Databuddy.
  process.env.DATABUDDY_TELEMETRY = "0";
  return () => fs.rmSync(root, { recursive: true, force: true });
}
