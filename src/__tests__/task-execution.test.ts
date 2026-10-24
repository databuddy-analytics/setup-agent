import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSetupTaskParams } from "../agents/run-task.js";
import { createRepositoryTaskRunner } from "../task-execution.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-task-history-"));
  roots.push(root);
  return root;
}
const params: RunSetupTaskParams = {
  agentType: "codex",
  projectRoot: "/synthetic",
  config: { model: "fixture" },
  prompt: "Inspect synthetic source",
};
function records(root: string): Record<string, unknown>[] {
  return fs
    .readdirSync(path.join(root, "runs"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(root, "runs", file), "utf8")));
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Repository task history and budgets", () => {
  it("counts repair and retry costs, preserves completed outputs, and refuses unknown costs", async () => {
    for (const cost of [1, undefined]) {
      const stateDir = fixture();
      let calls = 0;
      const execute = createRepositoryTaskRunner({
        stateDir,
        operation: "diagnosis",
        fingerprint: "source",
        maxCostUsd: 1,
        runTask: async ({ onMeta, beforeAttempt }) => {
          calls++;
          beforeAttempt?.();
          onMeta?.({ durationMs: 1, costUsd: cost });
          return '{"findings":[]}';
        },
      });
      expect(await execute("investigation", params)).toBe('{"findings":[]}');
      await expect(execute("repair", params)).rejects.toThrow(
        cost === undefined ? "cost is unavailable" : "cost limit",
      );
      expect(calls).toBe(1);
      expect(records(stateDir)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "complete",
            response: '{"findings":[]}',
            attempts: [expect.objectContaining({ durationMs: 1 })],
          }),
          expect.objectContaining({
            status: "limited",
            attempts: [],
            error: expect.objectContaining({ code: "COST_LIMIT" }),
          }),
        ]),
      );
    }
    const stateDir = fixture();
    const execute = createRepositoryTaskRunner({
      stateDir,
      operation: "setup",
      fingerprint: "source",
      maxCostUsd: 1,
      runTask: async ({ onMeta, beforeAttempt }) => {
        beforeAttempt?.();
        onMeta?.({ durationMs: 1, costUsd: 1 });
        beforeAttempt?.();
        throw new Error("A budgeted retry must never reach the provider");
      },
    });
    await expect(execute("planning", params)).rejects.toThrow("cost limit");
    expect(records(stateDir)).toMatchObject([{ status: "limited", attempts: [{ costUsd: 1 }] }]);
  });

  it("records terminal cancellation and redacts responses and errors", async () => {
    const stateDir = fixture();
    const execute = createRepositoryTaskRunner({
      stateDir,
      operation: "diagnosis",
      fingerprint: "source",
      runTask: async ({ onMeta }) => {
        onMeta?.({
          durationMs: 1,
          agentSessionId: "synthetic-session",
        });
        return '{"value":"dbdy_synthetic_token"}';
      },
    });
    await execute("investigation", params);
    const controller = new AbortController();
    const cancelled = createRepositoryTaskRunner({
      stateDir,
      operation: "diagnosis",
      fingerprint: "source",
      runTask: async () => {
        controller.abort(new Error("Synthetic cancellation dbdy_synthetic_token"));
        throw controller.signal.reason;
      },
    });
    await expect(
      cancelled("verification", { ...params, signal: controller.signal }),
    ).rejects.toThrow("Synthetic cancellation");
    const history = records(stateDir);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "complete",
          response: '{"value":"[REDACTED]"}',
          attempts: [expect.objectContaining({ agentSessionId: "synthetic-session" })],
        }),
        expect.objectContaining({
          status: "interrupted",
          error: expect.objectContaining({ message: "Synthetic cancellation [REDACTED]" }),
        }),
      ]),
    );
    expect(JSON.stringify(history)).not.toContain("provider body");
    expect(JSON.stringify(history)).not.toContain("dbdy_synthetic_token");
  });

  it("refuses a redirected history directory before calling an agent", async () => {
    const stateDir = fixture();
    fs.symlinkSync(fixture(), path.join(stateDir, "runs"));
    const execute = createRepositoryTaskRunner({
      stateDir,
      operation: "setup",
      fingerprint: "source",
      runTask: async () => {
        throw new Error("Unsafe history must never invoke an agent");
      },
    });
    await expect(execute("planning", params)).rejects.toThrow("regular directory");
  });
});
