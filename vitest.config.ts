import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve the real SDK from the installed npm package at test time.
      // The type stub in types/openclaw-plugin-sdk.d.ts is only used for tsc.
      "openclaw/plugin-sdk": new URL(
        "./node_modules/openclaw/dist/plugin-sdk/index.js",
        import.meta.url,
      ).pathname,
    },
  },
});
