import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts", "test/**/*.test.ts"],
    // Bundle and checkpoint suites spawn node and touch disk; give loaded CI runners headroom.
    testTimeout: 20_000,
    globalSetup: ["test/global-setup.ts"],
  },
});
