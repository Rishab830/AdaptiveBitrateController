import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", include: ["**/*.test.ts"] },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
