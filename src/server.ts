// Local Node HTTP entry (docs/ARCHITECTURE.md Repository Structure:
// "server.ts - local Node entry"). Mounts src/agent/routes.ts's Hono app on
// @hono/node-server. AWS Lambda gets its own entry point later
// (src/lambda.ts), out of scope for this step.

import { serve } from "@hono/node-server";
import { app } from "./agent/routes.js";

const DEFAULT_PORT = 8787;
const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`engram listening on http://localhost:${info.port}`);
});
