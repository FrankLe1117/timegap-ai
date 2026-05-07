#!/usr/bin/env node
/**
 * Compiles and runs scripts/smoke-replacement.ts.
 *
 * The project's source uses `@/...` path aliases. Node doesn't honor TypeScript
 * `paths` at runtime, so we install a tiny `Module._resolveFilename` hook that
 * rewrites `@/foo` → `<smoke-build-dir>/src/foo` before delegating back to the
 * default resolver. After that we just `require()` the compiled smoke entry
 * and let it run.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, ".smoke-build");

console.log("[smoke] compiling…");
const res = spawnSync(
  process.execPath,
  [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(__dirname, "smoke-tsconfig.json")],
  { stdio: "inherit", cwd: repoRoot },
);
if (res.status !== 0) {
  console.error("[smoke] tsc failed");
  process.exit(res.status || 1);
}

// Hook @/ alias to the compiled src directory.
const aliasRoot = path.join(buildDir, "src");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/")) {
    const rewritten = path.join(aliasRoot, request.slice(2));
    return origResolve.call(this, rewritten, parent, ...rest);
  }
  return origResolve.call(this, request, parent, ...rest);
};

const entry = path.join(buildDir, "scripts", "smoke-replacement.js");
console.log("[smoke] running", entry);
require(entry);
