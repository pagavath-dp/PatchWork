import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/activity.test.ts", "tests/github.test.ts", "tests/github-services.test.ts", "tests/health.test.ts", "tests/http.test.ts", "tests/workspace-membership.test.ts"] } });
