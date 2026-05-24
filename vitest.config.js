// vitest.config.js — place in project root
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    reporter: "verbose",
  },
});
