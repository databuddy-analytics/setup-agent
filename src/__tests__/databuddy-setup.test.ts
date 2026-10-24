import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceHunkReview, missingPlannedEvents, runDatabuddySetup } from "../databuddy-setup.js";
import type {
  DatabuddySetupChanges,
  DatabuddySetupPlan,
  DatabuddySetupRequest,
  DatabuddySetupSourceReview,
} from "../schema.js";

type RunTask = NonNullable<Parameters<typeof runDatabuddySetup>[0]["runTask"]>;

const roots: string[] = [];
const request: DatabuddySetupRequest = {
  websiteId: "synthetic-website",
  journey: "A visitor completes signup",
  products: ["sdk", "events"],
};

function write(repository: string, file: string, contents: string): void {
  const destination = path.join(repository, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function fixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-setup-"));
  roots.push(repository);
  write(repository, "package.json", JSON.stringify({ dependencies: { next: "fixture" } }));
  write(
    repository,
    "app/layout.tsx",
    "export default function Layout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
  );
  write(
    repository,
    "app/actions.ts",
    "export async function signup() {\n  const user = { id: 'synthetic-user' };\n  return { created: true, user };\n}\n",
  );
  return repository;
}

function plan(): DatabuddySetupPlan {
  const signupEvidence = [{ path: "app/actions.ts", line: 3, reason: "Signup succeeds here" }];
  return {
    framework: "nextjs",
    summary: "Install pageview tracking and record successful signups",
    steps: [
      {
        product: "sdk",
        change: "Mount the browser SDK in the root layout",
        evidence: [{ path: "app/layout.tsx", line: 2, reason: "Shared page layout" }],
        verification: "Visit a page and confirm one pageview for the website",
      },
      {
        product: "events",
        change: "Emit signup_completed after signup succeeds",
        evidence: signupEvidence,
        verification: "Complete a synthetic signup and query its event",
      },
    ],
    events: [
      {
        name: "signup_completed",
        source: "server",
        properties: { method: "Signup method, without email or other personal data" },
        evidence: signupEvidence,
      },
    ],
    recommendations: [
      {
        kind: "funnel",
        product: "events",
        priority: "journey",
        title: "Signup funnel",
        change: "Create a funnel from the signup page to signup_completed",
        rationale: "Measures where the stated journey loses people",
        evidence: signupEvidence,
        verification: "Open the funnel after one synthetic signup and confirm both steps count one",
        steps: [
          { type: "path", value: "/signup" },
          { type: "event", value: "signup_completed" },
        ],
      },
    ],
    unknowns: ["Website access has not been checked"],
  };
}

function implementation(): DatabuddySetupChanges {
  return {
    changes: [
      {
        product: "sdk",
        path: "app/layout.tsx",
        content: [
          'import { Databuddy } from "@databuddy/sdk/react";',
          "export default function Layout({ children }) {",
          '  return <html><body>{children}<Databuddy clientId="synthetic-website" /></body></html>;',
          "}",
          "",
        ].join("\n"),
      },
      {
        product: "events",
        path: "app/actions.ts",
        content: [
          'import { trackSignup } from "./analytics";',
          "export async function signup() {",
          "  const user = { id: 'synthetic-user' };",
          "  const result = { created: true, user };",
          "  await trackSignup();",
          "  return result;",
          "}",
          "",
        ].join("\n"),
      },
      {
        product: "events",
        path: "app/analytics.ts",
        content: [
          'import { Databuddy } from "@databuddy/sdk/node";',
          "export async function trackSignup() {",
          "  const apiKey = process.env.DATABUDDY_API_KEY;",
          "  if (!apiKey) return;",
          "  try {",
          '    const client = new Databuddy({ apiKey, websiteId: "synthetic-website" });',
          '    await client.track({ name: "signup_completed", source: "server", properties: { method: "password" } });',
          "    await client.flush();",
          "  } catch {",
          "    // Analytics must not fail a successful signup.",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ],
  };
}

function sourceReview(): DatabuddySetupSourceReview {
  return {
    passed: true,
    issues: [],
    unknowns: ["Runtime event delivery and website access remain unverified"],
  };
}

async function installFixtureSdk(repository: string): Promise<string> {
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  manifest.dependencies = { ...manifest.dependencies, "@databuddy/sdk": "3.0.1" };
  write(repository, "package.json", JSON.stringify(manifest));
  write(
    repository,
    "node_modules/@databuddy/sdk/package.json",
    JSON.stringify({
      name: "@databuddy/sdk",
      version: "3.0.1",
      exports: { ".": {}, "./react": {}, "./node": {} },
    }),
  );
  return "3.0.1";
}

function state(repository: string): { status: string; result?: unknown } {
  return JSON.parse(fs.readFileSync(path.join(repository, ".databuddy/setup.json"), "utf8"));
}

afterEach(() => {
  for (const repository of roots.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

describe("Databuddy setup planning", () => {
  it("persists an evidence-backed plan and resumes without claiming implementation or telemetry verification", async () => {
    const repository = fixture();
    let calls = 0;
    const runTask: RunTask = async () => {
      calls++;
      return JSON.stringify(plan());
    };
    const options = { repository, request, agentType: "codex" as const, runTask };

    const first = await runDatabuddySetup(options);
    const resumed = await runDatabuddySetup(options);

    expect(first.plan.events[0].name).toBe("signup_completed");
    expect(first.phases).toEqual({
      inspection: "complete",
      planning: "complete",
      implementation: "pending",
      verification: "pending",
      websiteAccess: "unverified",
    });
    expect(resumed).toEqual(first);
    expect(calls).toBe(1);
    expect(state(repository)).toMatchObject({ status: "planned", result: first });
    expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).not.toContain(
      "databuddy",
    );

    const forged = {
      ...state(repository),
      result: { ...first, phases: { ...first.phases, implementation: "complete" } },
    };
    write(repository, ".databuddy/setup.json", JSON.stringify(forged));
    const rebuilt = await runDatabuddySetup(options);
    expect(calls).toBe(2);
    expect(rebuilt.phases.implementation).toBe("pending");
    expect(state(repository)).toMatchObject({ status: "planned", result: rebuilt });
  });

  it("invalidates saved plans when source, request, model, or model route changes", async () => {
    const repository = fixture();
    let calls = 0;
    const runTask: RunTask = async () => {
      calls++;
      return JSON.stringify(plan());
    };
    const options = {
      repository,
      request,
      agentType: "codex" as const,
      config: { model: "fixture-a" },
      runTask,
    };

    await runDatabuddySetup(options);
    write(
      repository,
      "app/actions.ts",
      `${fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")}export const signupMethod = 'password';\n`,
    );
    await runDatabuddySetup(options);
    const changedRequest = { ...request, websiteId: "another-synthetic-website" };
    await runDatabuddySetup({ ...options, request: changedRequest });
    const changedModel = { ...options, request: changedRequest, config: { model: "fixture-b" } };
    await runDatabuddySetup(changedModel);
    const changedRoute = {
      ...changedModel,
      config: { model: "fixture-b", modelAuth: "api-key" },
    };
    await runDatabuddySetup(changedRoute);
    await runDatabuddySetup(changedRoute);

    expect(calls).toBe(5);
    expect(state(repository).status).toBe("planned");
  });

  it("rejects a plan when source changes during inspection and replans the changed repository", async () => {
    const repository = fixture();
    let calls = 0;
    const runTask: RunTask = async () => {
      calls++;
      if (calls === 1) {
        write(
          repository,
          "app/actions.ts",
          `${fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")}export const signupMethod = 'passkey';\n`,
        );
      }
      return JSON.stringify(plan());
    };
    const options = { repository, request, runTask };

    await expect(runDatabuddySetup(options)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(state(repository).status).toBe("failed");
    expect(state(repository).result).toBeUndefined();
    const recovered = await runDatabuddySetup(options);
    expect(calls).toBe(2);
    expect(state(repository)).toMatchObject({ status: "planned", result: recovered });
  });

  it("repairs a malformed response once and saves only the validated plan", async () => {
    const repository = fixture();
    let calls = 0;
    const runTask: RunTask = async () => {
      calls++;
      return calls === 1 ? "{ malformed" : JSON.stringify(plan());
    };

    const result = await runDatabuddySetup({ repository, request, runTask });

    expect(calls).toBe(2);
    expect(result.plan).toEqual(plan());
    expect(state(repository).status).toBe("planned");
  });

  it("plans non-Next.js frameworks from their manifests and refuses to apply them", async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-setup-astro-"));
    roots.push(repository);
    write(repository, "package.json", JSON.stringify({ dependencies: { astro: "fixture" } }));
    write(
      repository,
      "src/pages/index.astro",
      "---\n---\n<html><body><a href='/signup'>Go</a></body></html>\n",
    );
    write(
      repository,
      "src/lib/signup.ts",
      "export async function signup() {\n  return { created: true };\n}\n",
    );
    const astroPlan = (): DatabuddySetupPlan => {
      const evidence = [{ path: "src/lib/signup.ts", line: 2, reason: "Signup succeeds here" }];
      return {
        ...plan(),
        framework: "astro",
        steps: [
          {
            product: "sdk",
            change: "Add the script tag to the shared layout",
            evidence: [{ path: "src/pages/index.astro", line: 1, reason: "Page shell" }],
            verification: "Load the page and confirm one tracker request",
          },
          {
            product: "events",
            change: "Emit signup_completed",
            evidence,
            verification: "Query the event",
          },
        ],
        events: [
          {
            name: "signup_completed",
            source: "server",
            properties: { method: "Signup method" },
            evidence,
          },
        ],
        recommendations: [{ ...plan().recommendations[0], evidence }],
      };
    };
    let calls = 0;
    const runTask: RunTask = async ({ prompt }) => {
      calls++;
      expect(prompt).toContain("in a astro application");
      return JSON.stringify(calls === 1 ? { ...astroPlan(), framework: "nextjs" } : astroPlan());
    };
    const result = await runDatabuddySetup({ repository, request, runTask });
    expect(calls).toBe(2);
    expect(result.plan.framework).toBe("astro");
    await expect(runDatabuddySetup({ repository, request, runTask, apply: true })).rejects.toThrow(
      /--apply currently implements Next.js/,
    );
  });

  it("rejects recommendations that invent tracker options, orphan events, unknown funnel steps or skip the journey funnel", async () => {
    const repository = fixture();
    const cases: ((response: DatabuddySetupPlan) => void)[] = [
      (response) => {
        response.recommendations = [];
      },
      (response) => {
        response.recommendations[0].steps = [
          { type: "path", value: "/signup" },
          { type: "event", value: "never_tracked_anywhere" },
        ];
      },
      (response) => {
        response.recommendations.push({
          kind: "tracker_setting",
          product: "sdk",
          priority: "enrichment",
          title: "Invented option",
          change: "Set trackEverything",
          rationale: "none",
          evidence: response.recommendations[0].evidence,
          verification: "none",
          option: "trackEverything" as never,
          value: "true",
        });
      },
      (response) => {
        response.recommendations.push({
          kind: "custom_event",
          product: "events",
          priority: "journey",
          title: "Unplanned event",
          change: "Track checkout_completed",
          rationale: "none",
          evidence: response.recommendations[0].evidence,
          verification: "none",
          eventName: "checkout_completed",
        });
      },
      (response) => {
        response.recommendations.push({
          kind: "monitor",
          product: "uptime",
          priority: "enrichment",
          title: "Unrequested product",
          change: "Monitor the app",
          rationale: "none",
          evidence: response.recommendations[0].evidence,
          verification: "none",
        });
      },
    ];
    for (const mutate of cases) {
      let calls = 0;
      const runTask: RunTask = async () => {
        calls++;
        const response = plan();
        mutate(response);
        return JSON.stringify(response);
      };
      await expect(
        runDatabuddySetup({ repository: fixture(), request, runTask }),
      ).rejects.toThrow();
      expect(calls).toBe(2);
    }
    const accepted: RunTask = async () => {
      const response = plan();
      response.recommendations.push(
        {
          kind: "tracker_setting",
          product: "sdk",
          priority: "quality",
          title: "Capture runtime errors",
          change: "Set trackErrors to true on the Databuddy component",
          rationale: "The app has no error tracking",
          evidence: [{ path: "app/layout.tsx", line: 1, reason: "Tracker mount point" }],
          verification: "Throw a synthetic error and confirm an error event",
          option: "trackErrors",
          value: "true",
        },
        {
          kind: "goal",
          product: "events",
          priority: "journey",
          title: "Signup goal",
          change: "Create a goal on signup_completed",
          rationale: "Journey outcome",
          evidence: [{ path: "app/actions.ts", line: 3, reason: "Signup succeeds here" }],
          verification: "One conversion after a synthetic signup",
          target: { type: "event", value: "signup_completed" },
        },
      );
      return JSON.stringify(response);
    };
    const result = await runDatabuddySetup({ repository, request, runTask: accepted });
    expect(result.plan.recommendations).toHaveLength(3);
  });

  it("bounds invalid-plan repair, persists failure, and retries failed work on the next run", async () => {
    const repository = fixture();
    let calls = 0;
    let invalid = true;
    const runTask: RunTask = async () => {
      calls++;
      const response = plan();
      if (invalid) {
        response.steps[0].product = "flags";
        response.steps[0].evidence[0].line = 999;
      }
      return JSON.stringify(response);
    };
    const options = { repository, request, runTask };

    await expect(runDatabuddySetup(options)).rejects.toThrow();
    expect(calls).toBe(2);
    expect(state(repository)).toMatchObject({ status: "failed" });
    expect(state(repository).result).toBeUndefined();
    invalid = false;
    const recovered = await runDatabuddySetup(options);

    expect(calls).toBe(3);
    expect(state(repository)).toMatchObject({ status: "planned", result: recovered });
  });

  it("excludes sensitive, ignored, generated, and symlinked files and rejects anchors to each", async () => {
    const repository = fixture();
    write(repository, ".gitignore", "private/\n");
    const excluded = [
      ".env.local",
      "private/hidden.ts",
      "node_modules/example/index.ts",
      ".git/config",
      "linked.ts",
    ];
    for (const file of excluded.slice(0, -1)) write(repository, file, "PRIVATE_SYNTHETIC_MARKER\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-outside-"));
    roots.push(outside);
    write(outside, "secret.ts", "PRIVATE_SYNTHETIC_MARKER\n");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(repository, "linked.ts"));
    let calls = 0;

    for (const anchor of excluded) {
      const runTask: RunTask = async ({ projectRoot, prompt }) => {
        calls++;
        expect(projectRoot).not.toBe(repository);
        expect(prompt).not.toContain("PRIVATE_SYNTHETIC_MARKER");
        expect(fs.existsSync(path.join(projectRoot, "app/actions.ts"))).toBe(true);
        for (const file of excluded)
          expect(fs.existsSync(path.join(projectRoot, file))).toBe(false);
        const response = plan();
        response.steps[0].evidence = [{ path: anchor, line: 1, reason: "Untrusted anchor" }];
        return JSON.stringify(response);
      };
      await expect(runDatabuddySetup({ repository, request, runTask })).rejects.toThrow();
      expect(state(repository).status).toBe("failed");
      expect(fs.readFileSync(path.join(repository, ".databuddy/setup.json"), "utf8")).not.toContain(
        "PRIVATE_SYNTHETIC_MARKER",
      );
    }

    expect(calls).toBe(excluded.length * 2);
  });

  it("rejects concurrent work, preserves failed state on abort, and releases the lock for recovery", async () => {
    const repository = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTask: RunTask = async () => {
      entered();
      await blocked;
      return JSON.stringify(plan());
    };
    const first = runDatabuddySetup({ repository, request, runTask, signal: controller.signal });
    const aborted = expect(first).rejects.toThrow();
    await started;
    try {
      await expect(runDatabuddySetup({ repository, request, runTask })).rejects.toThrow();
    } finally {
      controller.abort();
      release();
    }
    await aborted;
    expect(state(repository).status).toBe("failed");
    expect(state(repository).result).toBeUndefined();

    const recovered = await runDatabuddySetup({
      repository,
      request,
      runTask: async () => JSON.stringify(plan()),
    });
    expect(state(repository)).toMatchObject({ status: "planned", result: recovered });
  });

  it("invalidates a saved plan when the framework changes and replans for the detected one", async () => {
    const repository = fixture();
    let calls = 0;
    let framework: DatabuddySetupPlan["framework"] = "nextjs";
    const runTask: RunTask = async () => {
      calls++;
      return JSON.stringify({ ...plan(), framework });
    };

    const options = { repository, request, runTask };
    await runDatabuddySetup(options);
    expect(state(repository).status).toBe("planned");
    write(repository, "package.json", JSON.stringify({ dependencies: { react: "fixture" } }));
    framework = "react";
    const replanned = await runDatabuddySetup(options);
    expect(calls).toBe(2);
    expect(replanned.plan.framework).toBe("react");
    expect(state(repository)).toMatchObject({ status: "planned", result: replanned });
  });
});

describe("Databuddy setup implementation", () => {
  it("reviews candidate files before applying private edits and reuses unchanged applied work", async () => {
    const repository = fixture();
    // pnpm apps carry a lockfile that the SDK installer rewrites.
    write(repository, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
    const layoutBefore = fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8");
    fs.chmodSync(path.join(repository, "app/layout.tsx"), 0o640);
    const proposal = implementation();
    let calls = 0;
    let installations = 0;
    const runTask: RunTask = async ({ projectRoot, prompt }) => {
      calls++;
      if (prompt.startsWith("Generate the smallest")) return JSON.stringify(proposal);
      if (prompt.startsWith("Independently verify")) {
        expect(projectRoot).not.toBe(repository);
        for (const change of proposal.changes)
          expect(fs.readFileSync(path.join(projectRoot, change.path), "utf8")).toBe(change.content);
        expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(
          actionsBefore,
        );
        expect(fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8")).toBe(layoutBefore);
        expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
        expect(fs.existsSync(path.join(repository, "node_modules/@databuddy/sdk"))).toBe(false);
        return JSON.stringify(sourceReview());
      }
      return JSON.stringify(plan());
    };
    const options = {
      repository,
      request,
      apply: true,
      runTask,
      installSdk: async (target: string) => {
        installations++;
        write(target, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# @databuddy/sdk 3.0.1\n");
        return installFixtureSdk(target);
      },
    };

    const result = await runDatabuddySetup(options);
    for (const change of proposal.changes)
      expect(fs.readFileSync(path.join(repository, change.path), "utf8")).toBe(change.content);
    expect(fs.statSync(path.join(repository, "app/layout.tsx")).mode & 0o777).toBe(0o640);
    expect(result.phases).toMatchObject({
      implementation: "complete",
      verification: "pending",
      websiteAccess: "unverified",
    });
    expect(result.implementation?.sdkVersion).toBe("3.0.1");
    expect(result.implementation?.files).toHaveLength(3);
    expect(result.implementation?.files).toContainEqual(
      expect.objectContaining({ path: "app/analytics.ts", beforeHash: null }),
    );
    expect(result.implementation?.sourceReview.unknowns).toContain(
      "Runtime event delivery and website access remain unverified",
    );
    const patch = path.join(repository, ".databuddy/setup.patch");
    expect(fs.statSync(patch).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(patch, "utf8")).toContain("signup_completed");
    expect(state(repository)).toMatchObject({ status: "applied", result });
    expect(calls).toBe(3);
    expect(installations).toBe(1);

    const resumed = await runDatabuddySetup({
      ...options,
      runTask: async () => {
        throw new Error("Applied work must not invoke a model");
      },
      installSdk: async () => {
        throw new Error("Unchanged installed SDK must not be reinstalled");
      },
    });
    expect(resumed).toEqual(result);
  });

  it("saves a reviewed patch without installing or writing, then applies it without model calls", async () => {
    const repository = fixture();
    const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
    const proposal = implementation();
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Generate the smallest")) return JSON.stringify(proposal);
      if (prompt.startsWith("Independently verify")) return JSON.stringify(sourceReview());
      return JSON.stringify(plan());
    };
    const patched = await runDatabuddySetup({
      repository,
      request,
      apply: true,
      patchOnly: true,
      runTask,
      installSdk: async () => {
        throw new Error("--patch must not install dependencies");
      },
    });
    expect(patched.phases.implementation).toBe("pending");
    expect(patched.patch).toMatchObject({
      diff: ".databuddy/setup.patch",
      files: proposal.changes.length,
    });
    expect(fs.readFileSync(path.join(repository, ".databuddy/setup.patch"), "utf8")).toContain(
      "app/analytics.ts",
    );
    expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(actionsBefore);
    expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);

    const applied = await runDatabuddySetup({
      repository,
      request,
      apply: true,
      runTask: async () => {
        throw new Error("Applying a reviewed patch must not call a model");
      },
      installSdk: async (target: string) => installFixtureSdk(target),
    });
    expect(applied.phases.implementation).toBe("complete");
    for (const change of proposal.changes)
      expect(fs.readFileSync(path.join(repository, change.path), "utf8")).toBe(change.content);
  });

  it("accepts a planned event deferred with a reason and reports it", async () => {
    const repository = fixture();
    const base = plan();
    const withProject: DatabuddySetupPlan = {
      ...base,
      events: [...base.events, { ...base.events[0], name: "project_created" }],
    };
    let reviewPrompt = "";
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Generate the smallest"))
        return JSON.stringify({
          ...implementation(),
          deferred: [
            { event: "project_created", reason: "No route creates a project yet." },
            { event: "not_planned", reason: "Ignored because it was never planned." },
          ],
        });
      if (prompt.startsWith("Independently verify")) {
        reviewPrompt = prompt;
        return JSON.stringify(sourceReview());
      }
      return JSON.stringify(withProject);
    };
    const result = await runDatabuddySetup({
      repository,
      request,
      apply: true,
      runTask,
      installSdk: async (target: string) => installFixtureSdk(target),
    });
    expect(reviewPrompt).toContain("No route creates a project yet.");
    expect(result.implementation?.deferred).toEqual([
      { event: "project_created", reason: "No route creates a project yet." },
    ]);
  });

  it("refuses to apply anything but the exact reviewed patch", async () => {
    for (const change of ["source", "patch"] as const) {
      const repository = fixture();
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
        if (prompt.startsWith("Independently verify")) return JSON.stringify(sourceReview());
        return JSON.stringify(plan());
      };
      await runDatabuddySetup({ repository, request, apply: true, patchOnly: true, runTask });
      // A person reviewed .databuddy/setup.patch; then something changed.
      if (change === "source") write(repository, "README.md", "Edited after review\n");
      else fs.appendFileSync(path.join(repository, ".databuddy/setup.patch"), "\n# edited\n");
      const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
      await expect(
        runDatabuddySetup({
          repository,
          request,
          apply: true,
          runTask: async () => {
            throw new Error("Applying must not re-plan or re-implement a reviewed patch");
          },
          installSdk: async () => {
            throw new Error("A refused patch must not install dependencies");
          },
        }),
      ).rejects.toThrow(change === "source" ? "different source or options" : "edited or removed");
      expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(actionsBefore);
      expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
    }
  });

  it("bounds independent review repair and leaves customer files untouched when review fails", async () => {
    const repository = fixture();
    const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
    const layoutBefore = fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8");
    let proposals = 0;
    let reviews = 0;
    let installations = 0;
    let finalCorrection = "";
    const runTask: RunTask = async ({ projectRoot, prompt }) => {
      if (prompt.startsWith("Generate the smallest")) {
        proposals++;
        finalCorrection = prompt;
        expect(fs.readFileSync(path.join(projectRoot, "app/actions.ts"), "utf8")).toBe(
          actionsBefore,
        );
        expect(fs.existsSync(path.join(projectRoot, "app/analytics.ts"))).toBe(false);
        return JSON.stringify(implementation());
      }
      if (prompt.startsWith("Independently verify")) {
        reviews++;
        expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(
          actionsBefore,
        );
        // Reviewers in real runs return located objects rather than strings.
        return JSON.stringify({
          passed: false,
          issues: [
            {
              path: "app/actions.ts:3",
              reason:
                reviews === 1
                  ? "Signup tracking duplicates an existing authoritative event"
                  : `Review ${reviews} found another defect`,
            },
          ],
          unknowns: ["Live delivery remains unverified"],
        });
      }
      return JSON.stringify(plan());
    };

    await expect(
      runDatabuddySetup({
        repository,
        request,
        apply: true,
        runTask,
        installSdk: async () => {
          installations++;
          throw new Error("Rejected changes must not install dependencies");
        },
      }),
    ).rejects.toThrow(
      "rejected the changes after 3 attempts; the last candidate is in .databuddy/rejected.patch: app/actions.ts:3: Review 3 found another defect",
    );
    expect(proposals).toBe(3);
    expect(reviews).toBe(3);
    // The last retry still carries the first review's issue.
    expect(finalCorrection).toContain("app/actions.ts:3: Signup tracking duplicates");
    expect(finalCorrection).toContain("app/actions.ts:3: Review 2 found another defect");
    expect(fs.readFileSync(path.join(repository, ".databuddy/rejected.patch"), "utf8")).toContain(
      "app/analytics.ts",
    );
    expect(installations).toBe(0);
    expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(actionsBefore);
    expect(fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8")).toBe(layoutBefore);
    expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repository, ".databuddy/setup.patch"))).toBe(false);
    expect(state(repository).status).toBe("planned");
  });

  it("rejects unsafe, excluded, symlinked, and redacted replacements before review or installation", async () => {
    const excluded = [
      "../outside.ts",
      ".env.local",
      "private/hidden.ts",
      "linked.ts",
      "app/layout.tsx",
      // Files that execute at build or request time, or configure the toolchain.
      "next.config.mjs",
      "middleware.ts",
      "src/instrumentation.ts",
      "scripts/postbuild.js",
      "tsconfig.json",
      "vercel.json",
    ];
    for (const target of excluded) {
      const repository = fixture();
      write(repository, ".gitignore", "private/\n");
      write(repository, ".env.local", "SYNTHETIC_PRIVATE_MARKER\n");
      write(repository, "private/hidden.ts", "SYNTHETIC_PRIVATE_MARKER\n");
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-outside-"));
      roots.push(outside);
      write(outside, "secret.ts", "SYNTHETIC_PRIVATE_MARKER\n");
      fs.symlinkSync(path.join(outside, "secret.ts"), path.join(repository, "linked.ts"));
      if (target === "app/layout.tsx") {
        write(
          repository,
          target,
          `${fs.readFileSync(path.join(repository, target), "utf8")}export const fixtureToken = "dbdy_syntheticKey00000000000000000000000000000000000000";\n`,
        );
      }
      const layoutBefore = fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8");
      const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
      let proposals = 0;
      const runTask: RunTask = async ({ projectRoot, prompt }) => {
        if (prompt.startsWith("Independently verify"))
          throw new Error("Unsafe edits must not reach source review");
        if (target === "app/layout.tsx") {
          const snapshot = fs.readFileSync(path.join(projectRoot, "app/layout.tsx"), "utf8");
          expect(snapshot).toContain("[REDACTED]");
          expect(snapshot).not.toContain("dbdy_syntheticKey00000000000000000000000000000000000000");
        }
        if (prompt.startsWith("Generate the smallest")) {
          proposals++;
          const proposal = implementation();
          proposal.changes[0].path = target;
          return JSON.stringify(proposal);
        }
        return JSON.stringify(plan());
      };

      await expect(
        runDatabuddySetup({
          repository,
          request,
          apply: true,
          runTask,
          installSdk: async () => {
            throw new Error("Unsafe edits must not install dependencies");
          },
        }),
      ).rejects.toThrow();
      expect(proposals).toBe(3);
      expect(fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8")).toBe(layoutBefore);
      expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(actionsBefore);
      expect(fs.readFileSync(path.join(outside, "secret.ts"), "utf8")).toBe(
        "SYNTHETIC_PRIVATE_MARKER\n",
      );
      expect(fs.lstatSync(path.join(repository, "linked.ts")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
      expect(fs.existsSync(path.join(repository, ".databuddy/setup.patch"))).toBe(false);
      expect(state(repository).status).toBe("planned");
    }
  });

  it("rejects source drift during independent review before installation or application", async () => {
    const repository = fixture();
    write(repository, "README.md", "Synthetic customer app\n");
    const layoutBefore = fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8");
    let installations = 0;
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
      if (prompt.startsWith("Independently verify")) {
        write(repository, "README.md", "Customer edits made during source review\n");
        return JSON.stringify(sourceReview());
      }
      return JSON.stringify(plan());
    };

    await expect(
      runDatabuddySetup({
        repository,
        request,
        apply: true,
        runTask,
        installSdk: async () => {
          installations++;
          throw new Error("Source drift must be detected before installation");
        },
      }),
    ).rejects.toThrow(/changed during implementation review/i);
    expect(installations).toBe(0);
    expect(fs.readFileSync(path.join(repository, "README.md"), "utf8")).toBe(
      "Customer edits made during source review\n",
    );
    expect(fs.readFileSync(path.join(repository, "app/layout.tsx"), "utf8")).toBe(layoutBefore);
    expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repository, ".databuddy/setup.patch"))).toBe(false);
    expect(state(repository).status).toBe("planned");
  });

  it("resumes the exact candidate after review interruption and preserves paid task history", async () => {
    for (const interruption of ["failure", "abort", "cost"] as const) {
      const repository = fixture();
      const controller = new AbortController();
      const proposal = implementation();
      let proposals = 0;
      let reviews = 0;
      const runTask: RunTask = async ({ prompt, onMeta }) => {
        onMeta?.({ durationMs: 1, costUsd: 1 });
        if (prompt.startsWith("Generate the smallest")) {
          proposals++;
          return JSON.stringify(proposal);
        }
        if (prompt.startsWith("Independently verify")) {
          reviews++;
          if (interruption === "failure") throw new Error("Synthetic review interruption");
          if (interruption === "abort") controller.abort(new Error("Synthetic cancellation"));
          return JSON.stringify(sourceReview());
        }
        return JSON.stringify(plan());
      };
      await expect(
        runDatabuddySetup({
          repository,
          request,
          apply: true,
          runTask,
          signal: controller.signal,
          maxCostUsd: interruption === "cost" ? 2 : undefined,
          installSdk: async () => {
            throw new Error("Incomplete review must not install");
          },
        }),
      ).rejects.toThrow();
      expect(state(repository).status).toBe("reviewing");
      expect(proposals).toBe(1);
      expect(reviews).toBe(interruption === "cost" ? 0 : 1);
      const history = path.join(repository, ".databuddy/runs");
      const files = fs.readdirSync(history);
      const prior = new Map(
        files.map((file) => [file, fs.readFileSync(path.join(history, file), "utf8")]),
      );
      expect(files.length).toBe(3);
      for (const file of files)
        expect(fs.statSync(path.join(history, file)).mode & 0o777).toBe(0o600);
      const completed = await runDatabuddySetup({
        repository,
        request,
        apply: true,
        maxCostUsd: 2,
        installSdk: installFixtureSdk,
        runTask: async ({ prompt, projectRoot, onMeta }) => {
          expect(prompt.startsWith("Independently verify")).toBe(true);
          for (const change of proposal.changes)
            expect(fs.readFileSync(path.join(projectRoot, change.path), "utf8")).toBe(
              change.content,
            );
          onMeta?.({ durationMs: 1, costUsd: 1 });
          return JSON.stringify(sourceReview());
        },
      });
      expect(completed.phases.implementation).toBe("complete");
      expect(fs.readdirSync(history).length).toBe(files.length + 1);
      for (const [file, contents] of prior)
        expect(fs.readFileSync(path.join(history, file), "utf8")).toBe(contents);
    }
  });

  it("recovers a final rejection saved before the terminal checkpoint write fails", async () => {
    const repository = fixture();
    let reviews = 0;
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (
        reviews === 3 &&
        String(to).endsWith("setup.json") &&
        JSON.parse(fs.readFileSync(from, "utf8")).status === "planned"
      )
        throw new Error("Synthetic terminal checkpoint write failure");
      return rename(from, to);
    });
    try {
      await expect(
        runDatabuddySetup({
          repository,
          request,
          apply: true,
          runTask: async ({ prompt }) => {
            if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
            if (prompt.startsWith("Independently verify")) {
              reviews++;
              return JSON.stringify({
                passed: false,
                issues: ["Duplicate signup event"],
                unknowns: [],
              });
            }
            return JSON.stringify(plan());
          },
        }),
      ).rejects.toThrow("Synthetic terminal checkpoint write failure");
    } finally {
      failure.mockRestore();
    }
    expect(state(repository).status).toBe("reviewing");
    await expect(
      runDatabuddySetup({
        repository,
        request,
        apply: true,
        runTask: async () => {
          throw new Error("Stored final rejection must not invoke a model");
        },
      }),
    ).rejects.toThrow("Duplicate signup event");
    expect(state(repository).status).toBe("planned");
  });

  it("resumes a durable reviewed journal after installer failure or cancellation without model calls", async () => {
    for (const interruption of ["failure", "abort"] as const) {
      const repository = fixture();
      const controller = new AbortController();
      const actionsBefore = fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8");
      let calls = 0;
      const runTask: RunTask = async ({ prompt }) => {
        calls++;
        if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
        if (prompt.startsWith("Independently verify")) return JSON.stringify(sourceReview());
        return JSON.stringify(plan());
      };
      const options = { repository, request, apply: true, runTask };

      await expect(
        runDatabuddySetup({
          ...options,
          signal: controller.signal,
          installSdk: async (target: string) => {
            if (interruption === "failure") throw new Error("Synthetic installer failure");
            await installFixtureSdk(target);
            controller.abort();
            return "3.0.1";
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(3);
      expect(state(repository)).toMatchObject({
        status: "applying",
        result: { phases: { implementation: "pending", verification: "pending" } },
      });
      expect(fs.readFileSync(path.join(repository, "app/actions.ts"), "utf8")).toBe(actionsBefore);
      expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
      const patchBefore = fs.readFileSync(path.join(repository, ".databuddy/setup.patch"), "utf8");
      const result = await runDatabuddySetup({
        ...options,
        runTask: async () => {
          throw new Error("Reviewed journal resume must not invoke a model");
        },
        installSdk: installFixtureSdk,
      });

      for (const change of implementation().changes)
        expect(fs.readFileSync(path.join(repository, change.path), "utf8")).toBe(change.content);
      expect(fs.readFileSync(path.join(repository, ".databuddy/setup.patch"), "utf8")).toBe(
        patchBefore,
      );
      expect(result.phases.implementation).toBe("complete");
      expect(result.phases.verification).toBe("pending");
      expect(state(repository)).toMatchObject({ status: "applied", result });
    }
  });

  it("keeps a partially staged new file unpublished and resumes the journal after a write failure", async () => {
    const repository = fs.realpathSync(fixture());
    const runTask: RunTask = async ({ prompt }) => {
      if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
      if (prompt.startsWith("Independently verify")) return JSON.stringify(sourceReview());
      return JSON.stringify(plan());
    };
    const originalWrite = fs.writeFileSync;
    const failingWrite = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(path.join(repository, "app/analytics.ts.tmp-"))
      ) {
        originalWrite(args[0], "Partial synthetic write", args[2]);
        throw new Error("Synthetic disk write interruption");
      }
      return originalWrite(...args);
    });
    try {
      await expect(
        runDatabuddySetup({
          repository,
          request,
          apply: true,
          runTask,
          installSdk: installFixtureSdk,
        }),
      ).rejects.toThrow("Synthetic disk write interruption");
    } finally {
      failingWrite.mockRestore();
    }
    expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
    expect(state(repository).status).toBe("applying");
    const result = await runDatabuddySetup({
      repository,
      request,
      apply: true,
      installSdk: installFixtureSdk,
      runTask: async () => {
        throw new Error("Write recovery must reuse the reviewed journal");
      },
    });
    expect(result.phases.implementation).toBe("complete");
    for (const change of implementation().changes)
      expect(fs.readFileSync(path.join(repository, change.path), "utf8")).toBe(change.content);
  });

  it("preserves interrupted work and refuses customer changes to edited or unedited source on resume", async () => {
    for (const changedFile of ["app/layout.tsx", "README.md"]) {
      const repository = fixture();
      write(repository, "README.md", "Synthetic customer app\n");
      const runTask: RunTask = async ({ prompt }) => {
        if (prompt.startsWith("Generate the smallest")) return JSON.stringify(implementation());
        if (prompt.startsWith("Independently verify")) return JSON.stringify(sourceReview());
        return JSON.stringify(plan());
      };
      const options = { repository, request, apply: true, runTask };
      await expect(
        runDatabuddySetup({
          ...options,
          installSdk: async () => {
            throw new Error("Synthetic installer failure");
          },
        }),
      ).rejects.toThrow(/installer failure/i);
      const savedState = fs.readFileSync(path.join(repository, ".databuddy/setup.json"), "utf8");
      const savedPatch = fs.readFileSync(path.join(repository, ".databuddy/setup.patch"), "utf8");
      const customerChange = `${fs.readFileSync(path.join(repository, changedFile), "utf8")}// Customer work after interruption\n`;
      write(repository, changedFile, customerChange);

      await expect(
        runDatabuddySetup({
          ...options,
          runTask: async () => {
            throw new Error("Journal conflicts must not invoke a model");
          },
          installSdk: async () => {
            throw new Error("Journal conflicts must be detected before installation");
          },
        }),
      ).rejects.toThrow(/repository changed during implementation/i);
      expect(fs.readFileSync(path.join(repository, changedFile), "utf8")).toBe(customerChange);
      expect(fs.readFileSync(path.join(repository, ".databuddy/setup.json"), "utf8")).toBe(
        savedState,
      );
      expect(fs.readFileSync(path.join(repository, ".databuddy/setup.patch"), "utf8")).toBe(
        savedPatch,
      );
      expect(fs.existsSync(path.join(repository, "app/analytics.ts"))).toBe(false);
      expect(state(repository).status).toBe("applying");
    }
  });
});

describe("source review hunk accounting", () => {
  it("rejects a passing review that marks an unrelated restyle, keeping the planned hunks", () => {
    const review = enforceHunkReview(
      {
        passed: true,
        issues: [],
        unknowns: ["Live delivery remains unverified"],
        hunks: [
          { id: "H1", related: true, purpose: "mounts the tracker in the root layout" },
          { id: "H2", related: false, purpose: "adds backdrop-blur-none to the cart modal" },
        ],
      },
      [
        { id: "H1", location: "app/layout.tsx:34" },
        { id: "H2", location: "components/cart/modal.tsx:72" },
      ],
    );
    expect(review.passed).toBe(false);
    expect(review.issues).toEqual([
      "components/cart/modal.tsx:72: remove this change; the requested setup does not need it (adds backdrop-blur-none to the cart modal)",
    ]);
  });
});

describe("planned event coverage", () => {
  it("names planned events the proposal never sends, counting events already in source", () => {
    const base = plan();
    const withStageChange: DatabuddySetupPlan = {
      ...base,
      events: [...base.events, { ...base.events[0], name: "deal_stage_changed" }],
    };
    const changes = [
      {
        path: "app/actions.ts",
        content: 'await track("signup_completed", { method: "password" });',
      },
    ];
    expect(missingPlannedEvents(withStageChange, changes, new Map())).toEqual([
      "deal_stage_changed",
    ]);
    expect(
      missingPlannedEvents(
        withStageChange,
        changes,
        new Map([["lib/stage.ts", "client.track({ name: 'deal_stage_changed' });"]]),
      ),
    ).toEqual([]);
  });
});
