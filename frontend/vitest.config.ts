import { defineConfig } from "vitest/config";

/** Отдельный конфиг для vitest (не трогает vite.config.ts с dev/preview proxy
 *  на backend). Тестируем только чистые функции — DOM-окружение не нужно. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
