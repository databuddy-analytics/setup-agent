import { spawn } from "node:child_process";
import { createSetupRedactor, normalizeTerminalLine } from "./terminal.js";

interface CheckResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  output: string;
}

const OUTPUT_TAIL = 4_000;

/**
 * Run the user's own verification commands (for example a typecheck or a
 * formatter check) in the repository after edits are applied. The agent never
 * chooses these: running a project's tools executes its configuration, so it
 * happens only for commands the user passed with --check.
 */
export async function runChecks(
  repository: string,
  commands: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const redact = createSetupRedactor();
  const results: CheckResult[] = [];
  for (const command of commands) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const { exitCode, output } = await new Promise<{ exitCode: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(command, {
          cwd: repository,
          shell: true,
          signal: options.signal,
          timeout: options.timeoutMs ?? 600_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const append = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code, output }));
      },
    );
    results.push({
      command,
      exitCode,
      passed: exitCode === 0,
      durationMs: Date.now() - started,
      output: redact(
        output
          .split(/\r?\n/)
          .map((line) => normalizeTerminalLine(line))
          .join("\n")
          .trim()
          .slice(-OUTPUT_TAIL),
      ),
    });
  }
  return results;
}
