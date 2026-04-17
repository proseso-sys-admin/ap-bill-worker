import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.mjs"],
    reporters: ["default"],
    testTimeout: 10_000
  }
});
