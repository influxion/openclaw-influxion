import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve the real SDK from the installed npm package at test time.
      "openclaw/plugin-sdk": new URL(
        "./node_modules/openclaw/dist/plugin-sdk/index.js",
        import.meta.url,
      ).pathname,
    },
  },
});
