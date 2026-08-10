#!/usr/bin/env node
// Launcher for the "engram-mcp" bin entry (package.json). This repo has no
// build step that emits JS - package.json's "build" script only typechecks
// (`tsc --noEmit`, no dist/ output), matching the "no build step" pattern
// used elsewhere in the repo (e.g. public/dashboard.html). There is nothing
// for `bin` to point at directly, so this launcher spawns tsx's own JS
// entrypoint directly against the TypeScript server entrypoint, inheriting
// stdio so the MCP stdio transport still talks directly to the parent
// process's stdin/stdout.
//
// Spawns process.execPath with node_modules/tsx/dist/cli.mjs rather than the
// node_modules/.bin/tsx shim (or npx): on Windows, spawning the tsx.cmd/
// npx.cmd shim directly (no shell:true) fails with EINVAL on Node 24
// (verified) - going straight to tsx's actual bin target sidesteps the
// platform-specific shim entirely. Mirrors scripts/cloud-migrate.mjs's
// documented approach for the same problem.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const serverPath = path.join(repoRoot, "src", "mcp", "server.ts");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const child = spawn(process.execPath, [tsxCli, serverPath], { stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("engram-mcp: failed to start:", err.message);
  process.exit(1);
});
