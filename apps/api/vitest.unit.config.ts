import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/github.test.ts", "tests/github-services.test.ts", "tests/health.test.ts"] } });
