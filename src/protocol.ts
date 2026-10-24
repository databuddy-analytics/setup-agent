// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
export class SetupProtocolError extends Error {
  readonly code: string;
  readonly kind: "limit" | "failure";
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: string;
    message: string;
    kind: "limit" | "failure";
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "SetupProtocolError";
    this.code = options.code;
    this.kind = options.kind;
    this.details = options.details;
  }
}

/** Exit 3 marks a resumable limit, such as the cost cap; everything else is 1. */
export function setupErrorExitCode(error: unknown): number {
  return error instanceof SetupProtocolError && error.kind === "limit" ? 3 : 1;
}
