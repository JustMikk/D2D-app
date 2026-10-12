import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          env: { NODE_ENV: "test" },
        },
      },
      {
        // Each test file gets its own copy of a freshly pushed SQLite database (backend spec §13).
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: { NODE_ENV: "test", APP_BASE_URL: "http://canvass.test", MEDIA_SIGNING_SECRET: "m".repeat(40) },
          globalSetup: ["tests/integration/globalSetup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          // next-auth imports "next/server" without an extension, which plain Node ESM cannot resolve.
          server: { deps: { inline: ["next-auth"] } },
        },
      },
    ],
  },
});
