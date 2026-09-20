import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ui/src/**/__tests__ is included deliberately and narrowly: the frontend has no test
    // runner of its own, and a couple of its modules (e.g. hooks/speakableText.ts) are pure
    // dependency-free logic worth covering. The pattern reaches only __tests__ directories
    // under ui/src, so Playwright's specs in ui/e2e are not picked up by vitest.
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "ui/src/**/__tests__/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "ui/node_modules", "ui/dist", "ui/e2e"],
    testTimeout: 30_000,
  },
});
