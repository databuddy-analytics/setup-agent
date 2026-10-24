// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeCodexSetupResult, runCodexSetupTask } from "../agents/codex.js";
import { runSetupTask } from "../agents/run-task.js";
import { QuotaExhaustedError } from "../agents/shared.js";

vi.mock("../agents/codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/codex.js")>()),
  runCodexSetupTask: vi.fn(async () => {
    throw new Error("Offline adapter reached");
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(runCodexSetupTask)
    .mockReset()
    .mockImplementation(async () => {
      throw new Error("Offline adapter reached");
    });
});

describe("Codex setup result", () => {
  it("parses the final schema response without narration or stale earlier JSON", () => {
    const result = finalizeCodexSetupResult(
      ["Reading source…", '```json\n{"stale":true}\n```', '{"complete":true}'],
      "",
    );
    expect(JSON.parse(result)).toEqual({ complete: true });
    expect(() => finalizeCodexSetupResult([], "")).toThrow("Codex produced no setup result");
  });

  it("does not accept partial output after the turn fails", () => {
    expect(() => finalizeCodexSetupResult(["partial JSON"], "Codex setup turn failed")).toThrow(
      "Codex setup turn failed",
    );
  });

  it("classifies setup quota failures", () => {
    expect(() => finalizeCodexSetupResult(["partial JSON"], "You've hit your usage limit")).toThrow(
      QuotaExhaustedError,
    );
  });

  it("preserves cancellation reasons without masking unrelated adapter failures", async () => {
    const controller = new AbortController();
    const reason = new Error("Databuddy diagnosis exceeded 600 seconds.");
    const task = {
      agentType: "codex" as const,
      projectRoot: "/synthetic",
      prompt: "Inspect",
      config: {},
      signal: controller.signal,
    };
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    vi.mocked(runCodexSetupTask).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw abort;
    });
    await expect(runSetupTask(task)).rejects.toBe(reason);

    const otherController = new AbortController();
    const failure = new Error("Adapter failed independently of cancellation");
    vi.mocked(runCodexSetupTask).mockImplementationOnce(async () => {
      otherController.abort(reason);
      throw failure;
    });
    await expect(runSetupTask({ ...task, signal: otherController.signal })).rejects.toBe(failure);
    expect(runCodexSetupTask).toHaveBeenCalledTimes(2);
  });

  it("does not invoke an adapter for an already cancelled task", async () => {
    const reason = new Error("Cancelled before invocation");
    await expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(runCodexSetupTask).not.toHaveBeenCalled();
  });

  it("retries transient failures with fresh invocations and returns the successful result", async () => {
    vi.useFakeTimers();
    vi.mocked(runCodexSetupTask)
      .mockRejectedValueOnce(new Error("503 temporarily unavailable"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce('{"complete":true}');
    const outcome = expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
      }),
    ).resolves.toBe('{"complete":true}');
    await vi.runAllTimersAsync();
    await outcome;
    expect(runCodexSetupTask).toHaveBeenCalledTimes(3);
  });

  it("stops after three transient failures", async () => {
    vi.useFakeTimers();
    const failure = new Error("503 temporarily unavailable");
    vi.mocked(runCodexSetupTask).mockRejectedValue(failure);
    const outcome = expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
      }),
    ).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await outcome;
    expect(runCodexSetupTask).toHaveBeenCalledTimes(3);
  });

  it("retries Codex's exact silent completion error", async () => {
    vi.useFakeTimers();
    vi.mocked(runCodexSetupTask)
      .mockRejectedValueOnce(new Error("Codex produced no setup result"))
      .mockResolvedValueOnce('{"complete":true}');
    const outcome = expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
      }),
    ).resolves.toBe('{"complete":true}');
    await vi.runAllTimersAsync();
    await outcome;
    expect(runCodexSetupTask).toHaveBeenCalledTimes(2);
  });

  it.each([
    "401 unauthorized: temporary timeout",
    "Invalid API key: 503 temporarily unavailable",
    "Unsupported configuration",
  ])("does not retry terminal failures: %s", async (message) => {
    const failure = new Error(message);
    vi.mocked(runCodexSetupTask).mockRejectedValueOnce(failure);
    await expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
      }),
    ).rejects.toBe(failure);
    expect(runCodexSetupTask).toHaveBeenCalledTimes(1);
  });

  it("classifies quota failures without retrying", async () => {
    vi.mocked(runCodexSetupTask).mockRejectedValueOnce(new Error("You've hit your usage limit"));
    await expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
      }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(runCodexSetupTask).toHaveBeenCalledTimes(1);
  });

  it("cancels retry backoff before another invocation starts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("Cancelled during retry backoff");
    vi.mocked(runCodexSetupTask).mockRejectedValueOnce(new Error("503 temporarily unavailable"));
    const outcome = expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    await outcome;
    expect(runCodexSetupTask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry metadata callback failures that resemble provider failures", async () => {
    const budgetFailure = new Error("Budget timeout: 503");
    vi.mocked(runCodexSetupTask).mockImplementationOnce(async (params) => {
      try {
        throw new Error("503 temporarily unavailable");
      } finally {
        params.onMeta?.({ durationMs: 10, costUsd: 1 });
      }
    });
    await expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
        onMeta: () => {
          throw budgetFailure;
        },
      }),
    ).rejects.toBe(budgetFailure);
    expect(runCodexSetupTask).toHaveBeenCalledTimes(1);
  });

  it("checks accumulated attempt cost before starting a fresh retry", async () => {
    vi.useFakeTimers();
    let accumulatedCost = 0;
    const budgetFailure = new Error("Budget timeout: 503");
    vi.mocked(runCodexSetupTask).mockImplementationOnce(async (params) => {
      try {
        throw new Error("503 temporarily unavailable");
      } finally {
        params.onMeta?.({ durationMs: 10, costUsd: 1 });
      }
    });
    const outcome = expect(
      runSetupTask({
        agentType: "codex" as const,
        projectRoot: "/synthetic",
        prompt: "Inspect",
        config: {},
        onMeta: (meta) => {
          if (meta.costUsd !== undefined) accumulatedCost += meta.costUsd;
        },
        beforeAttempt: () => {
          if (accumulatedCost >= 1) throw budgetFailure;
        },
      }),
    ).rejects.toBe(budgetFailure);
    await vi.runAllTimersAsync();
    await outcome;
    expect(runCodexSetupTask).toHaveBeenCalledTimes(1);
  });
});
