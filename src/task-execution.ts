import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type RunSetupTaskParams, runSetupTask } from "./agents/run-task.js";
import type { BatchMeta } from "./agents/types.js";
import { atomicWriteFileSync } from "./atomic-file.js";
import { SetupProtocolError } from "./protocol.js";
import { createSetupRedactor } from "./terminal.js";

interface TaskRecord {
  version: 1;
  runId: string;
  pid: number;
  hostname: string;
  task: number;
  operation: "setup" | "diagnosis";
  phase: string;
  fingerprint: string;
  agentType: string;
  model?: string;
  reasoningEffort?: string;
  thinkingLevel?: string;
  promptDigest: string;
  prompt: string;
  runCost: { knownUsd: number; incomplete: boolean };
  limitUsd?: number;
  startedAt: string;
  completedAt?: string;
  status: "running" | "complete" | "error" | "interrupted" | "limited";
  attempts: BatchMeta[];
  response?: string;
  error?: { code: string; message: string };
}

/** Retain each paid task and stop at invocation boundaries, like the batch processor. */
export function createRepositoryTaskRunner(options: {
  stateDir: string;
  operation: TaskRecord["operation"];
  fingerprint: string;
  maxCostUsd?: number;
  runTask?: typeof runSetupTask;
}): (phase: string, params: RunSetupTaskParams) => Promise<string> {
  if (
    options.maxCostUsd !== undefined &&
    (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)
  )
    throw new Error("Cost limit must be a positive finite USD amount");
  const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
  const redact = createSetupRedactor();
  let task = 0;
  let costUsd = 0;
  let costUnknown = false;
  const assertBudget = () => {
    if (options.maxCostUsd !== undefined && (costUsd >= options.maxCostUsd || costUnknown))
      throw new SetupProtocolError({
        code: "COST_LIMIT",
        kind: "limit",
        message: costUnknown
          ? "Agent cost is unavailable; no further paid tasks were started under the cost limit. Rerun to resume."
          : `Estimated cost limit $${options.maxCostUsd} reached; rerun to resume saved work.`,
        details: { limitUsd: options.maxCostUsd, knownCostUsd: costUsd, costUnknown },
      });
  };
  return async (phase, params) => {
    params.signal?.throwIfAborted();
    if (Buffer.byteLength(params.prompt) > 20 * 1024 * 1024)
      throw new Error("Agent prompt exceeds the 20 MiB task artifact limit");
    const directory = path.join(options.stateDir, "runs");
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error("Task history must be a regular directory inside .databuddy");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record: TaskRecord = {
      version: 1,
      runId,
      pid: process.pid,
      hostname: os.hostname(),
      task: ++task,
      operation: options.operation,
      phase,
      fingerprint: options.fingerprint,
      agentType: params.agentType,
      ...(typeof params.config.model === "string" ? { model: params.config.model } : {}),
      ...(typeof params.config.reasoningEffort === "string"
        ? { reasoningEffort: params.config.reasoningEffort }
        : {}),
      ...(typeof params.config.thinkingLevel === "string"
        ? { thinkingLevel: params.config.thinkingLevel }
        : {}),
      promptDigest: createHash("sha256").update(params.prompt).digest("hex"),
      prompt: redact(params.prompt),
      runCost: { knownUsd: costUsd, incomplete: costUnknown },
      ...(options.maxCostUsd !== undefined ? { limitUsd: options.maxCostUsd } : {}),
      startedAt: new Date().toISOString(),
      status: "running",
      attempts: [],
    };
    const file = path.join(directory, `${runId}-${task}.json`);
    const save = () => {
      record.runCost = { knownUsd: costUsd, incomplete: costUnknown };
      atomicWriteFileSync(file, `${redact(JSON.stringify(record, null, 2))}\n`, { mode: 0o600 });
    };
    save();
    let invoked = false;
    try {
      assertBudget();
      invoked = true;
      const response = await (options.runTask ?? runSetupTask)({
        ...params,
        beforeAttempt: () => {
          params.signal?.throwIfAborted();
          assertBudget();
          params.beforeAttempt?.();
        },
        onMeta: (meta) => {
          // Stderr/provider envelopes can contain credentials; retain only typed usage fields.
          const safe: BatchMeta = {
            durationMs: meta.durationMs,
            durationApiMs: meta.durationApiMs,
            numTurns: meta.numTurns,
            costUsd: meta.costUsd,
            agentSessionId: meta.agentSessionId,
            usage: meta.usage,
          };
          record.attempts.push(safe);
          if (
            typeof safe.costUsd === "number" &&
            Number.isFinite(safe.costUsd) &&
            safe.costUsd >= 0
          )
            costUsd += safe.costUsd;
          else {
            safe.costUsd = undefined;
            costUnknown = true;
          }
          save();
          params.onMeta?.(safe);
        },
      });
      params.signal?.throwIfAborted();
      if (record.attempts.length === 0) costUnknown = true;
      if (Buffer.byteLength(response) > 20 * 1024 * 1024)
        throw new Error("Agent response exceeds the 20 MiB task artifact limit");
      record.response = redact(response);
      record.status = "complete";
      return response;
    } catch (error) {
      if (invoked && record.attempts.length === 0) costUnknown = true;
      record.status =
        error instanceof SetupProtocolError && error.kind === "limit"
          ? "limited"
          : params.signal?.aborted
            ? "interrupted"
            : "error";
      record.error = {
        code:
          error instanceof SetupProtocolError
            ? error.code
            : error instanceof Error
              ? error.name
              : "Error",
        message: redact(error instanceof Error ? error.message : String(error)),
      };
      throw error;
    } finally {
      record.completedAt = new Date().toISOString();
      save();
    }
  };
}
