#!/usr/bin/env node
// Launcher for the "engram-mcp" bin entry (package.json). This repo has no
// build step that emits JS - package.json's "build" script only typechecks
// (`tsc --noEmit`, no dist/ output), matching the "no build step" pattern
// used elsewhere in the repo (e.g. public/dashboard.html). There is nothing
// for `bin` to point at directly, so this launcher re-execs `npx tsx`
// against the TypeScript server entrypoint (the same command as the "mcp"
// npm script and the README's registration example), inheriting stdio so
// the MCP stdio transport still talks directly to the parent process's
// stdin/stdout. Simplest correct option for a project with no build step;
// documented in README.md's MCP section.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "mcp", "server.ts");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npxCommand, ["tsx", serverPath], { stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("engram-mcp: failed to start:", err.message);
  process.exit(1);
});
