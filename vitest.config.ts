import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // At runtime in tests, resolve the real SDK from the linked openclaw devDependency.
      // The type stub in types/openclaw-plugin-sdk.d.ts is only used for tsc.
      "openclaw/plugin-sdk": new URL("../openclaw/src/plugin-sdk/index.ts", import.meta.url)
        .pathname,
    },
  },
});
