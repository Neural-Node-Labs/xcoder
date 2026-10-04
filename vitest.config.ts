import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ui/src/**/__tests__ is included deliberately and narrowly: the frontend has no test
    // runner of its own, and a couple of its modules (e.g. hooks/speakableText.ts) are pure
    // dependency-free logic worth covering. The pattern reaches only __tests__ directories
    // under ui/src, so Playwright's specs in ui/e2e are not picked up by vitest.
    //
    // That "pure dependency-free logic" scope is why .test.tsx files never matched here in the
    // first place (keepAlive.test.tsx needs jsdom + @testing-library/react to render components,
    // neither installed at this root level — only under ui/node_modules, since ui's own `npm
    // test` runs those). hologramRegistry.test.ts needs the same jsdom environment (it exercises
    // localStorage/window.dispatchEvent) despite the .ts extension, so it's excluded by name
    // below rather than by extension — it runs correctly under `cd ui && npm test` instead,
    // which does have jsdom.
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "ui/src/**/__tests__/**/*.test.ts",
      "integrations/agi/tests/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "ui/node_modules", "ui/dist", "ui/e2e", "ui/src/__tests__/hologramRegistry.test.ts"],
    testTimeout: 30_000,
  },
});
