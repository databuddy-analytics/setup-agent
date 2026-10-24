import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "../checks.js";

describe("post-apply checks", () => {
  it("runs each command in the repository and records failures with redacted output", async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-checks-"));
    fs.writeFileSync(path.join(repository, "marker.txt"), "inside");
    const results = await runChecks(repository, [
      "node -e \"process.stdout.write(require('fs').readFileSync('marker.txt','utf8'))\"",
      "node -e \"console.error('Bearer abcdefghijklmnop'); process.exit(2)\"",
    ]);
    expect(results.map((result) => [result.passed, result.exitCode])).toEqual([
      [true, 0],
      [false, 2],
    ]);
    expect(results[0].output).toBe("inside");
    expect(results[1].output).not.toContain("abcdefghijklmnop");
  });
});
