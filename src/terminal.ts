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

const TOKEN_PATTERNS: RegExp[] = [
  /\bdbdy_[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:vck|vercel|sk|sess)-[A-Za-z0-9._-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Provider key formats that appear hardcoded in source.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}\b/g,
  /\bkey-[0-9a-f]{32}\b/g,
];

// Patterns that keep a prefix (the URL scheme and user, or the key name).
const PREFIXED_PATTERNS: [RegExp, string][] = [
  [/([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi, "$1[REDACTED]@"],
  // A quoted, space-free value of 16+ characters assigned to a secret-named key.
  [
    /((?:secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|token|password|passwd)["']?\s*[:=]\s*["'`])[^"'`\s]{16,}(?=["'`])/gi,
    "$1[REDACTED]",
  ],
  // An identifier naming a secret (dbPass, stripeSecret, apiToken) assigned a
  // quoted value that mixes letters and digits.
  [
    /(\b[\w$]*(?:pass(?:word|wd)?|pwd|secret|token|api_?key|access_?key|private_?key|credential)[\w$]*["']?\s*[:=]\s*["'`])(?=[^"'`\s]*\d)(?=[^"'`\s]*[A-Za-z])[^"'`\s]{10,}(?=["'`])/gi,
    "$1[REDACTED]",
  ],
  // Unquoted values for secret-named keys in YAML, TOML, INI and env files.
  [
    /^(\s*[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]*\s*[:=]\s*)(?!["'`$({]|(?:process|import|Deno|Bun)\.)([^\s,;()]{8,})\s*$/gim,
    "$1[REDACTED]",
  ],
];

// Random-looking quoted values of 32+ characters, such as a cloud secret on an
// innocently named key. Hex digests top out at 4 bits per character, below the
// threshold, so hashes and IDs stay readable.
const HIGH_ENTROPY_LITERAL = /(["'`])([A-Za-z0-9+/=_-]{32,})\1/g;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

function redactHighEntropy(input: string): string {
  return input.replace(HIGH_ENTROPY_LITERAL, (match, quote: string, value: string) =>
    /\d/.test(value) && /[A-Za-z]/.test(value) && !value.startsWith("/") && entropy(value) >= 4.3
      ? `${quote}[REDACTED]${quote}`
      : match,
  );
}

/** Redact credential-named environment values, provider key formats and secret assignments. */
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
    for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, "[REDACTED]");
    for (const [pattern, replacement] of PREFIXED_PATTERNS)
      output = output.replace(pattern, replacement);
    output = redactHighEntropy(output);
    return output;
  };
}
