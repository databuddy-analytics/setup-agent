import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack, runPayload, sendTelemetry, telemetryMode } from "../telemetry.js";

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-telemetry-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: { next: "15", "better-auth": "1", "@acme/private-billing": "1" },
      devDependencies: { typescript: "5", "internal-design-tokens": "2" },
    }),
  );
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

describe("run telemetry", () => {
  it("names only well-known packages, never private dependencies", () => {
    expect(detectStack(repository())).toEqual({
      packageManager: "pnpm",
      packages: ["better-auth", "next", "typescript"],
    });
  });

  it("reports a failure with a typed issue and no paths, repository or credentials", () => {
    const root = repository();
    const payload = runPayload({
      command: "setup",
      websiteId: "site_synthetic",
      repository: root,
      agent: "codex",
      model: "gpt-6-sol",
      durationMs: 1200,
      error: new Error(
        `Implementation source review rejected the changes after 3 attempts; the last candidate is in ${root}/.databuddy/rejected.patch: src/lib/billing.ts:4 leaks sk-live-0123456789abcdef`,
      ),
    });
    const sent = JSON.stringify(payload);
    expect(payload.status).toBe("failed");
    expect(payload.issues).toEqual([{ type: "review_rejected", resolved: false }]);
    expect(sent).not.toContain(root);
    expect(sent).not.toContain("billing");
    expect(sent).not.toContain("sk-live");
    expect(sent).not.toContain("private-billing");
    expect(payload.metadata).toMatchObject({ packageManager: "pnpm", agentBackend: "codex" });
  });

  it("honours every opt-out and never throws when the network fails", async () => {
    expect(telemetryMode({ DO_NOT_TRACK: "1" })).toBe("off");
    expect(telemetryMode({ DO_NOT_TRACK: "true" })).toBe("off");
    expect(telemetryMode({ DO_NOT_TRACK: "0" })).toBe("send");
    expect(telemetryMode({ DATABUDDY_TELEMETRY: "print" }, true)).toBe("off");
    expect(telemetryMode({ DATABUDDY_TELEMETRY: "0" })).toBe("off");
    expect(telemetryMode({}, true)).toBe("off");
    expect(telemetryMode({ DATABUDDY_TELEMETRY: "print" })).toBe("print");
    expect(telemetryMode({})).toBe("send");
    let calls = 0;
    const payload = runPayload({
      command: "report",
      websiteId: "site_synthetic",
      repository: repository(),
      agent: "claude",
      model: "claude-opus-5-5",
      durationMs: 1,
      artifact: { framework: "nextjs", findings: [{ category: "problem" }], unknowns: [] },
    });
    expect(
      await sendTelemetry(payload, {
        mode: "off",
        fetchImpl: async () => {
          calls++;
          return new Response();
        },
      }),
    ).toBe("off");
    expect(calls).toBe(0);
    expect(
      await sendTelemetry(payload, {
        mode: "send",
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe("failed");
  });
});
