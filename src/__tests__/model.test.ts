import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentConfig, assertAgentCredential, findAgentExecutable } from "../model.js";

function binDir(...names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-bin-"));
  for (const name of names) fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

function codexHome(withLogin: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "databuddy-codex-home-"));
  if (withLogin) fs.writeFileSync(path.join(home, "auth.json"), "{}");
  return home;
}

describe("model selection", () => {
  it("defaults the model per backend and keeps the auth route in the fingerprinted config", () => {
    expect(agentConfig({ agent: "codex", thinkingLevel: "medium", auth: "local" })).toEqual({
      model: "gpt-6-sol",
      thinkingLevel: "medium",
      reasoningEffort: "medium",
      modelAuth: "local",
    });
    expect(
      agentConfig({
        agent: "claude",
        model: "claude-sonnet-5-5",
        thinkingLevel: "high",
        auth: "api-key",
      }).model,
    ).toBe("claude-sonnet-5-5");
  });

  it("drives the installed CLI and reports a missing one before any model call", () => {
    const bin = binDir("codex");
    expect(findAgentExecutable("codex", { PATH: bin })).toBe(path.join(bin, "codex"));
    expect(findAgentExecutable("claude", { PATH: bin })).toBeUndefined();
    expect(() =>
      assertAgentCredential(
        { agent: "claude", auth: "api-key" },
        { PATH: bin, ANTHROPIC_API_KEY: "x" },
      ),
    ).toThrow("npm install -g @anthropic-ai/claude-code");
  });

  it("accepts a local Codex login and rejects a missing one", () => {
    const PATH = binDir("codex");
    expect(() =>
      assertAgentCredential(
        { agent: "codex", auth: "local" },
        { PATH, CODEX_HOME: codexHome(true) },
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentCredential(
        { agent: "codex", auth: "local" },
        { PATH, CODEX_HOME: codexHome(false) },
      ),
    ).toThrow("codex login");
  });

  it("refuses a local run that ambient API credentials would silently bill", () => {
    expect(() =>
      assertAgentCredential(
        { agent: "codex", auth: "local" },
        { PATH: binDir("codex"), CODEX_HOME: codexHome(true), OPENAI_API_KEY: "sk-synthetic" },
      ),
    ).toThrow("OPENAI_API_KEY");
  });

  it("requires the backend's own API key for api-key auth", () => {
    const PATH = binDir("claude");
    expect(() =>
      assertAgentCredential({ agent: "claude", auth: "api-key" }, { PATH, OPENAI_API_KEY: "sk-x" }),
    ).toThrow("ANTHROPIC_API_KEY");
    expect(() =>
      assertAgentCredential({ agent: "claude", auth: "api-key" }, { PATH, ANTHROPIC_API_KEY: "x" }),
    ).not.toThrow();
  });
});
