#!/usr/bin/env node
/**
 * Compiles and runs scripts/smoke-multi-plan-diversity.ts.
 * Mirrors run-smoke.cjs.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, ".smoke-build");

console.log("[smoke:multi-plan] compiling…");
const res = spawnSync(
  process.execPath,
  [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(__dirname, "smoke-multi-plan-diversity-tsconfig.json")],
  { stdio: "inherit", cwd: repoRoot },
);
if (res.status !== 0) {
  console.error("[smoke:multi-plan] tsc failed");
  process.exit(res.status || 1);
}

const aliasRoot = path.join(buildDir, "src");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/")) {
    const rewritten = path.join(aliasRoot, request.slice(2));
    return origResolve.call(this, rewritten, parent, ...rest);
  }
  return origResolve.call(this, request, parent, ...rest);
};

const entry = path.join(buildDir, "scripts", "smoke-multi-plan-diversity.js");
console.log("[smoke:multi-plan] running", entry);
require(entry);
