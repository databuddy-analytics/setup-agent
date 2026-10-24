import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATABUDDY_REFERENCE_TOPICS,
  REFERENCE_SNAPSHOT_DIR,
  readDatabuddyReference,
  referenceIndex,
  SETUP_PRODUCT_TOPICS,
  topicsForProducts,
  writeReferenceSnapshot,
} from "../databuddy-reference.js";
import { DatabuddySetupProductSchema, DatabuddyTrackerOptionSchema } from "../schema.js";

const REQUIRED_HEADINGS = [
  "## What it is",
  "## Exact API",
  "## When to recommend it",
  "## How to implement",
  "## How to verify",
  "## Pitfalls",
];

describe("databuddy reference", () => {
  it("ships a sourced reference file with every required section for each topic", () => {
    for (const topic of DATABUDDY_REFERENCE_TOPICS) {
      const text = readDatabuddyReference(topic);
      expect(text.trimStart().startsWith("<!--"), `${topic} must cite its sources`).toBe(true);
      for (const heading of REQUIRED_HEADINGS)
        expect(text.includes(heading), `${topic} is missing ${heading}`).toBe(true);
      expect(text.length).toBeLessThan(40_000);
    }
  });

  it("documents every tracker option the plan contract accepts", () => {
    const tracker = readDatabuddyReference("tracker");
    for (const option of DatabuddyTrackerOptionSchema.options)
      expect(tracker.includes(option), `tracker.md must document ${option}`).toBe(true);
  });

  it("maps every setup product to at least one topic", () => {
    for (const product of DatabuddySetupProductSchema.options)
      expect(SETUP_PRODUCT_TOPICS[product].length).toBeGreaterThan(0);
    expect(topicsForProducts(["sdk", "events"])).toEqual(
      DATABUDDY_REFERENCE_TOPICS.filter((topic) =>
        ["tracker", "frameworks", "privacy", "custom-events", "server-sdk", "query-api"].includes(
          topic,
        ),
      ),
    );
  });

  it("writes read-only reference files into a hidden snapshot directory and indexes them", () => {
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-reference-"));
    try {
      const written = writeReferenceSnapshot(snapshot, ["links", "uptime"]);
      expect(written).toEqual([
        `${REFERENCE_SNAPSHOT_DIR}/links.md`,
        `${REFERENCE_SNAPSHOT_DIR}/uptime.md`,
      ]);
      for (const file of written) {
        const stat = fs.statSync(path.join(snapshot, file));
        expect(stat.mode & 0o200).toBe(0);
      }
      const index = referenceIndex(["links", "uptime"]);
      expect(index).toContain(`${REFERENCE_SNAPSHOT_DIR}/links.md`);
      expect(index).not.toContain("tracker.md");
    } finally {
      fs.rmSync(snapshot, { recursive: true, force: true });
    }
  });
});
