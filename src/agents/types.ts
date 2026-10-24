// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
export interface AgentProgress {
  type: "started" | "tool_use" | "thinking" | "complete" | "error";
  message: string;
}

/** A general read-only repository task used by first-run setup. */
export interface SetupTaskParams {
  prompt: string;
  projectRoot: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Check task budgets before every fresh adapter invocation. */
  beforeAttempt?: () => void;
  /** Continue an earlier adapter session (its file reads stay in context) instead of starting fresh. */
  resumeAgentSessionId?: string;
  /** Metadata for this adapter invocation, including unsuccessful attempts. */
  onMeta?: (meta: BatchMeta) => void;
}

export interface BatchMeta {
  durationMs: number;
  durationApiMs?: number;
  numTurns?: number;
  costUsd?: number;
  agentSessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}
