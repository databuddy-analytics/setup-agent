// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
// Covers CSI color/cursor sequences and OSC title/hyperlink sequences. Child
// output is persisted as text, never replayed as terminal control.
const ANSI_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g;

export function normalizeTerminalLine(value: string, maxChars = 2_000): string {
  const normalized = value
    .replace(ANSI_SEQUENCE, "")
    .replaceAll("\u0008", "")
    .replaceAll("\u0000", "")
    .trimEnd();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}… [truncated]`
    : normalized;
}

const TOKEN_PATTERNS = [
  /\bdbdy_[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:vck|vercel|sk|sess)-[A-Za-z0-9._-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi,
];

/** Redact credential-named environment values and known token shapes. */
export function createSetupRedactor(
  env: NodeJS.ProcessEnv = process.env,
): (value: string) => string {
  const secrets = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        Boolean(entry[1]) &&
        /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(entry[0]) &&
        (entry[1]?.length ?? 0) >= 8,
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let output = input;
    for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
    for (const pattern of TOKEN_PATTERNS) {
      output = output.replace(pattern, (_match, capture) =>
        typeof capture === "string" ? `${capture}[REDACTED]@` : "[REDACTED]",
      );
    }
    return output;
  };
}
