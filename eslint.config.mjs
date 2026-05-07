import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Smoke test build artifacts and the cjs runner are not part of the
    // shipped Next.js bundle.
    ".smoke-build/**",
    "scripts/run-smoke.cjs",
    "scripts/run-smoke-zh-time.cjs",
    "scripts/run-smoke-buffer.cjs",
    "scripts/run-smoke-place-sanitize.cjs",
  ]),
]);

export default eslintConfig;
