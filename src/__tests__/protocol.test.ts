// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeError, SetupProtocolError, setupErrorExitCode } from "../protocol.js";
import { DatabuddyDiagnosisInvestigationSchema } from "../schema.js";

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

  it("describes schema failures in one readable line instead of raw JSON", () => {
    const failure = z.object({ findings: z.array(z.object({ id: z.string() })) }).safeParse({
      findings: [{ id: 3 }],
    });
    expect(failure.success).toBe(false);
    expect(describeError(failure.error)).toBe(
      "The model's answer did not match the expected format: findings.0.id: Expected string, received number",
    );
  });

  it("drops keys a model invents on a recommendation instead of failing the run", () => {
    const investigation = {
      summary: "Signup is tracked once.",
      findings: [
        {
          id: "events_1",
          area: "events",
          category: "recommendation",
          basis: "source",
          title: "Track signup completion",
          explanation: "The handler confirms the account before returning.",
          evidence: [{ path: "app/actions.ts", line: 4, quote: "return user", reason: "success" }],
          nextCheck: "Sign up once and confirm one event.",
          recommendation: {
            kind: "custom_event",
            priority: "journey",
            eventName: "signup_completed",
            reference: "custom-events.md",
            capability: "events",
            action: "track",
            answers: "Who finished signup",
          },
        },
      ],
      unknowns: [],
    };
    const parsed = DatabuddyDiagnosisInvestigationSchema.safeParse(investigation);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
