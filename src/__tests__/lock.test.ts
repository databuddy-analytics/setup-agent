// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSetupLock } from "../lock.js";
import { SetupProtocolError } from "../protocol.js";

describe("setup workspace lock", () => {
  it("rejects a concurrent owner and can be reacquired after release", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-lock-"));
    const release = acquireSetupLock(workspace);
    expect(() => acquireSetupLock(workspace)).toThrow(SetupProtocolError);
    release();
    const releaseAgain = acquireSetupLock(workspace);
    releaseAgain();
  });

  it("does not steal a lock while its owner record is still being written", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-lock-record-"));
    const file = path.join(workspace, "setup.lock");
    try {
      fs.writeFileSync(file, "");
      expect(() => acquireSetupLock(workspace)).toThrow(SetupProtocolError);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-stale-lock-"));
    fs.writeFileSync(
      path.join(workspace, "setup.lock"),
      JSON.stringify({ pid: 999_999_999, startedAt: "old", command: [] }),
    );
    const release = acquireSetupLock(workspace);
    release();
  });
});
