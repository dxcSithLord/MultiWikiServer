import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The workspace packages publish their TS source via the "module" field
// (./src/index.ts) with no main/exports, which vite won't resolve for a bare
// import. Alias each to its source so the unit tests run without a build step.
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tiddlywiki/events": src("./packages/events/src/index.ts"),
      "@tiddlywiki/commander": src("./packages/commander/src/index.ts"),
      "@tiddlywiki/server": src("./packages/server/src/index.ts"),
      "@tiddlywiki/utils": src("./packages/utils/src/index.ts"),
      "@mjackson/multipart-parser": src("./packages/multipart-parser/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
