// AWS Lambda entry point (docs/plans/2026-08-09-phase-4-ship.md Step 1):
// "hono/aws-lambda adapter around the same app as src/server.ts". Mounts the
// identical Hono app src/agent/routes.ts exports - no route or boundary
// logic duplicated here, matching src/server.ts's shape for the local entry.
// Bundled by scripts/deploy-lambda.mjs into dist/lambda/index.mjs; not run
// directly outside Lambda (no local `serve()` call here, unlike server.ts).

import { handle } from "hono/aws-lambda";
import { app } from "./agent/routes.js";

export const handler = handle(app);
