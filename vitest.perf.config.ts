import { configDefaults, defineConfig } from "vitest/config";
import { CACHE_DIR, TEST_EXCLUDE } from "./vite.config.ts";

/**
 * Frame-timing tests (`*.perf.test.ts`). They measure wall-clock time, so files
 * run one at a time: other test files competing for the CPUs would make them flaky.
 */
export default defineConfig({
  cacheDir: CACHE_DIR,
  test: {
    include: ["src/**/*.perf.test.ts"],
    exclude: [...configDefaults.exclude, ...TEST_EXCLUDE],
    fileParallelism: false,
  },
});
