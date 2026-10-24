// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import type { AgentBackend } from "../model.js";
import { runClaudeSetupTask } from "./claude.js";
import { runCodexSetupTask } from "./codex.js";
import {
  backoff,
  classifyQuotaError,
  isTransientError,
  MAX_ATTEMPTS,
  QuotaExhaustedError,
} from "./shared.js";
import type { BatchMeta, SetupTaskParams } from "./types.js";

export interface RunSetupTaskParams extends SetupTaskParams {
  agentType: AgentBackend;
}

/** Run one schema-oriented, read-only repository task through a built-in agent. */
export async function runSetupTask(params: RunSetupTaskParams): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    params.signal?.throwIfAborted();
    params.beforeAttempt?.();
    let metadataCallbackFailed = false;
    const attemptParams = {
      ...params,
      onMeta: params.onMeta
        ? (meta: BatchMeta) => {
            try {
              params.onMeta?.(meta);
            } catch (error) {
              metadataCallbackFailed = true;
              throw error;
            }
          }
        : undefined,
    };
    try {
      return params.agentType === "codex"
        ? await runCodexSetupTask(attemptParams)
        : await runClaudeSetupTask(attemptParams);
    } catch (error) {
      if (metadataCallbackFailed) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        if (params.signal?.aborted) throw params.signal.reason;
        throw error;
      }
      if (params.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const quota = classifyQuotaError(message, params.agentType);
      if (quota) {
        if (error instanceof QuotaExhaustedError) throw error;
        throw new QuotaExhaustedError(quota, message);
      }
      const authenticationFailure =
        /\b(?:401|403|unauthorized|forbidden|authentication_error|invalid_api_key)\b/i.test(
          message,
        ) ||
        /\b(?:authentication|authorization) (?:failed|required|error)\b/i.test(message) ||
        /\b(?:invalid|expired) (?:api key|auth token|access token|refresh token|credentials)\b/i.test(
          message,
        );
      const retryable =
        isTransientError(message) ||
        (params.agentType === "codex" && message === "Codex produced no setup result");
      if (authenticationFailure || attempt === MAX_ATTEMPTS || !retryable) {
        throw error;
      }
      params.onProgress?.({
        type: "error",
        message: `Retrying repository task after a transient error (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      });
      await backoff(attempt, params.signal);
    }
  }
  throw new Error("Repository task attempts exhausted");
}
