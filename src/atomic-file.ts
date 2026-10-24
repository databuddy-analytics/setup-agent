// Derived from DeepSec (https://github.com/vercel-labs/deepsec), Copyright 2026 Vercel, Inc.
// and contributors, licensed under Apache-2.0. Modified by Databuddy; see NOTICE.
import fs from "node:fs";
import path from "node:path";

function temporaryPath(file: string): string {
  return `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

export function atomicWriteFileSync(
  file: string,
  contents: string,
  options: { mode?: number; overwrite?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = temporaryPath(file);
  try {
    fs.writeFileSync(temp, contents, { encoding: "utf8", mode: options.mode, flag: "wx" });
    if (options.overwrite === false) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
