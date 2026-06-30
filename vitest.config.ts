import { defineConfig } from "vitest/config";

// Pin this project's test config so vitest uses a Node environment and only
// these src tests, instead of climbing up to inherit an ancestor config (e.g.
// a jsdom/browser config) if this is ever nested inside a larger workspace.
export default defineConfig({
  // root defaults to this config file's directory, which pins vitest here.
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
