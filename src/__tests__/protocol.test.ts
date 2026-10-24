// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { describe, expect, it } from "vitest";
import { SetupProtocolError, setupErrorExitCode } from "../protocol.js";

describe("setup exit codes", () => {
  it("uses a distinct exit code for resumable limits", () => {
    expect(
      setupErrorExitCode(
        new SetupProtocolError({ code: "COST_LIMIT", message: "Stopped", kind: "limit" }),
      ),
    ).toBe(3);
    expect(
      setupErrorExitCode(
        new SetupProtocolError({ code: "SETUP_ALREADY_RUNNING", message: "Busy", kind: "failure" }),
      ),
    ).toBe(1);
    expect(setupErrorExitCode(new Error("boom"))).toBe(1);
  });
});
