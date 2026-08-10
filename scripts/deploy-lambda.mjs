#!/usr/bin/env node
// Idempotent Lambda deploy (docs/plans/2026-08-09-phase-4-ship.md Step 1):
// bundles src/lambda.ts with esbuild, zips it with certs/crdb-root.crt,
// creates/updates the IAM role + Lambda function + public Function URL via
// the AWS CLI (profile h0, us-east-1). Safe to re-run: every AWS call either
// checks first or is itself idempotent.
//
// SECRET HANDLING (CRITICAL - see the task brief this script was written
// against): ENGRAM_CLOUD_DATABASE_URL is read from .env in-process and only
// ever written into a scratch env.json file consumed by
// `aws lambda ... --environment file://...`; it is never placed on a CLI
// argument and never printed. The scratch file is deleted immediately after
// the aws call that reads it, in the finally block below.
//
// Usage: node scripts/deploy-lambda.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const PROFILE = process.env.AWS_PROFILE_OVERRIDE ?? "h0";
const REGION = process.env.AWS_REGION_OVERRIDE ?? "us-east-1";
const FUNCTION_NAME = "engram-demo";
const ROLE_NAME = "engram-lambda-role";
const RUNTIME_CANDIDATES = ["nodejs22.x", "nodejs20.x"];
const MEMORY_MB = 512;
const TIMEOUT_S = 30;
// Cost ceiling on the public, unauthenticated Function URL - caps concurrent
// executions so no single traffic spike (or abuse) can run up an unbounded
// Bedrock/CockroachDB bill.
const RESERVED_CONCURRENCY = 5;

// A fresh, uniquely-named temp dir per run (never a fixed, committed path -
// this repo is public, and a hardcoded path under one user's profile is both
// a minor info leak and wrong on any other machine). Cleaned up in main()'s
// finally block, but only when this script created it itself.
const ownScratchDir = process.env.ENGRAM_SCRATCH_DIR === undefined;
const scratchDir = process.env.ENGRAM_SCRATCH_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "engram-"));

function log(msg) {
  console.log(`[deploy-lambda] ${msg}`);
}

// --- .env reader (mirrors src/db.ts's loadDotEnv; standalone here so this
// script has no dependency on db.ts, which would otherwise open a pg pool
// path we don't need). Returns a plain object; caller is responsible for
// never printing values from it. ------------------------------------------
function readDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// Resolves the real aws executable rather than shelling out through the
// `aws` name lookup: on Windows the AWS CLI v2 ships a genuine .exe (unlike
// npm-installed tools such as tsx, which ship a .cmd shim that spawnSync
// rejects with EINVAL unless shell:true - verified while building
// cloud-migrate.mjs), so this avoids needing shell:true's unescaped-arg risk
// entirely rather than trading one platform workaround for another.
const AWS_BIN =
  process.platform === "win32" && fs.existsSync("C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe")
    ? "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"
    : "aws";

function awsArgs(args) {
  return [...args, "--profile", PROFILE, "--region", REGION];
}

/** Runs an AWS CLI subcommand, returns {ok, stdout, stderr}. Never logs args containing secret material - callers must keep secrets out of `args` (file:// only). */
function aws(args) {
  const full = awsArgs(args);
  try {
    const stdout = execFileSync(AWS_BIN, full, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    return { ok: false, stdout, stderr: stderr || err.message };
  }
}

function toWin32FileUrl(absPath) {
  return `file://${absPath.replace(/\\/g, "/")}`;
}

// --- Step A: bundle -------------------------------------------------------
async function bundle() {
  const pkgDir = path.join(repoRoot, "dist", "lambda-package");
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "certs"), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "public"), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(repoRoot, "src", "lambda.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(pkgDir, "index.mjs"),
    external: ["pg-native"],
    // pg's optional native client wraps `require('pg-native')` in a
    // try/catch that is never reached by our code path (we only use pg's
    // pure-JS client) - marking it external avoids esbuild trying to
    // resolve a package that is not installed (verified: node_modules/pg-native
    // does not exist; node_modules/pg-cloudflare does and bundles fine).
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    // Safety net for any bundled CJS dependency that references a bare
    // `require(...)` esbuild couldn't statically rewrite in ESM output.
    logLevel: "warning",
  });

  fs.copyFileSync(path.join(repoRoot, "certs", "crdb-root.crt"), path.join(pkgDir, "certs", "crdb-root.crt"));
  // routes.ts's GET /dashboard reads public/dashboard.html off disk at
  // request time (not bundled as a JS string) - resolveDashboardPath() in
  // src/agent/routes.ts checks `here`-relative first, which resolves to this
  // sibling public/ directory once deployed (/var/task/public/dashboard.html).
  fs.copyFileSync(path.join(repoRoot, "public", "dashboard.html"), path.join(pkgDir, "public", "dashboard.html"));

  const zipPath = path.join(repoRoot, "dist", "lambda.zip");
  fs.rmSync(zipPath, { force: true });
  const psCommand = `Compress-Archive -Path '${pkgDir.replace(/\\/g, "/")}/*' -DestinationPath '${zipPath.replace(
    /\\/g,
    "/"
  )}' -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { encoding: "utf8" });

  const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
  log(`bundled + zipped: dist/lambda.zip (${sizeMb} MB)`);
  return zipPath;
}

// --- Step B: IAM role -------------------------------------------------------
async function ensureRole() {
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  };
  const bedrockPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource: "*",
      },
    ],
  };

  const trustPath = path.join(scratchDir, "engram-trust-policy.json");
  const bedrockPath = path.join(scratchDir, "engram-bedrock-policy.json");
  fs.writeFileSync(trustPath, JSON.stringify(trustPolicy));
  fs.writeFileSync(bedrockPath, JSON.stringify(bedrockPolicy));

  let created = false;
  try {
    const getRole = aws(["iam", "get-role", "--role-name", ROLE_NAME, "--output", "json"]);
    if (!getRole.ok) {
      log(`role ${ROLE_NAME} not found, creating...`);
      const createRole = aws([
        "iam",
        "create-role",
        "--role-name",
        ROLE_NAME,
        "--assume-role-policy-document",
        toWin32FileUrl(trustPath),
        "--description",
        "engram Lambda execution role (logs + bedrock invoke)",
      ]);
      if (!createRole.ok) {
        return { ok: false, deniedReason: createRole.stderr };
      }
      created = true;
    } else {
      log(`role ${ROLE_NAME} already exists`);
    }

    const attach = aws([
      "iam",
      "attach-role-policy",
      "--role-name",
      ROLE_NAME,
      "--policy-arn",
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ]);
    if (!attach.ok) return { ok: false, deniedReason: attach.stderr };

    const putPolicy = aws([
      "iam",
      "put-role-policy",
      "--role-name",
      ROLE_NAME,
      "--policy-name",
      "engram-bedrock-invoke",
      "--policy-document",
      toWin32FileUrl(bedrockPath),
    ]);
    if (!putPolicy.ok) return { ok: false, deniedReason: putPolicy.stderr };

    const getRoleArn = aws(["iam", "get-role", "--role-name", ROLE_NAME, "--query", "Role.Arn", "--output", "text"]);
    if (!getRoleArn.ok) return { ok: false, deniedReason: getRoleArn.stderr };

    return { ok: true, roleArn: getRoleArn.stdout.trim(), created };
  } finally {
    fs.rmSync(trustPath, { force: true });
    fs.rmSync(bedrockPath, { force: true });
  }
}

// --- Step C: function -------------------------------------------------------
async function ensureFunction(roleArn, roleJustCreated, zipPath, cloudDbUrl) {
  const envPath = path.join(scratchDir, "engram-lambda-env.json");
  try {
    fs.writeFileSync(envPath, JSON.stringify({ Variables: { ENGRAM_DATABASE_URL: cloudDbUrl } }));

    const getFn = aws(["lambda", "get-function", "--function-name", FUNCTION_NAME, "--output", "json"]);
    const exists = getFn.ok;

    if (!exists) {
      log(`function ${FUNCTION_NAME} not found, creating...`);
      let lastErr = "";
      for (const runtime of RUNTIME_CANDIDATES) {
        // IAM eventual consistency: a just-created role can 400 on the first
        // create-function attempt ("role defined ... cannot be assumed").
        // Small bounded retry rather than a fixed sleep up front.
        const attempts = roleJustCreated ? 5 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const create = aws([
            "lambda",
            "create-function",
            "--function-name",
            FUNCTION_NAME,
            "--runtime",
            runtime,
            "--role",
            roleArn,
            "--handler",
            "index.handler",
            "--zip-file",
            `fileb://${zipPath.replace(/\\/g, "/")}`,
            "--memory-size",
            String(MEMORY_MB),
            "--timeout",
            String(TIMEOUT_S),
            "--environment",
            toWin32FileUrl(envPath),
          ]);
          if (create.ok) {
            log(`created function with runtime ${runtime}`);
            aws(["lambda", "wait", "function-active", "--function-name", FUNCTION_NAME]);
            return { ok: true, created: true, runtime };
          }
          lastErr = create.stderr;
          if (/cannot be assumed|InvalidParameterValueException.*role/i.test(create.stderr) && attempt < attempts) {
            log(`role not yet assumable, retrying (${attempt}/${attempts})...`);
            execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 5"]);
            continue;
          }
          if (/Runtime.*not supported|InvalidParameterValueException.*[Rr]untime/i.test(create.stderr)) {
            log(`runtime ${runtime} rejected, trying next candidate`);
            break;
          }
          return { ok: false, deniedReason: create.stderr };
        }
      }
      return { ok: false, deniedReason: lastErr };
    }

    log(`function ${FUNCTION_NAME} already exists, updating...`);
    const updateCode = aws([
      "lambda",
      "update-function-code",
      "--function-name",
      FUNCTION_NAME,
      "--zip-file",
      `fileb://${zipPath.replace(/\\/g, "/")}`,
    ]);
    if (!updateCode.ok) return { ok: false, deniedReason: updateCode.stderr };
    aws(["lambda", "wait", "function-updated", "--function-name", FUNCTION_NAME]);

    const updateConfig = aws([
      "lambda",
      "update-function-configuration",
      "--function-name",
      FUNCTION_NAME,
      "--memory-size",
      String(MEMORY_MB),
      "--timeout",
      String(TIMEOUT_S),
      "--environment",
      toWin32FileUrl(envPath),
    ]);
    if (!updateConfig.ok) return { ok: false, deniedReason: updateConfig.stderr };
    aws(["lambda", "wait", "function-updated", "--function-name", FUNCTION_NAME]);

    return { ok: true, created: false };
  } finally {
    // CRITICAL: this scratch file is the only place the cloud DB URL is
    // written to disk. Deleted immediately after every aws call above that
    // could need it, success or failure.
    fs.rmSync(envPath, { force: true });
  }
}

// --- Step D: Function URL ---------------------------------------------------
async function ensureFunctionUrl() {
  const getUrl = aws(["lambda", "get-function-url-config", "--function-name", FUNCTION_NAME, "--output", "json"]);
  let functionUrl;
  if (!getUrl.ok) {
    log("creating Function URL (auth NONE)...");
    const create = aws([
      "lambda",
      "create-function-url-config",
      "--function-name",
      FUNCTION_NAME,
      "--auth-type",
      "NONE",
      "--output",
      "json",
    ]);
    if (!create.ok) return { ok: false, deniedReason: create.stderr };
    functionUrl = JSON.parse(create.stdout).FunctionUrl;
  } else {
    functionUrl = JSON.parse(getUrl.stdout).FunctionUrl;
    log("Function URL already configured");
  }

  const getPolicy = aws(["lambda", "get-policy", "--function-name", FUNCTION_NAME, "--output", "json"]);
  const hasPublicStatement = getPolicy.ok && getPolicy.stdout.includes("FunctionURLAllowPublicAccess");
  if (!hasPublicStatement) {
    log("adding public invoke permission for the Function URL...");
    const addPerm = aws([
      "lambda",
      "add-permission",
      "--function-name",
      FUNCTION_NAME,
      "--action",
      "lambda:InvokeFunctionUrl",
      "--statement-id",
      "FunctionURLAllowPublicAccess",
      "--principal",
      "*",
      "--function-url-auth-type",
      "NONE",
    ]);
    if (!addPerm.ok && !/ResourceConflictException/i.test(addPerm.stderr)) {
      return { ok: false, deniedReason: addPerm.stderr };
    }
  }

  // Since Oct 2025, public NONE-auth Function URLs 403 unless the resource
  // policy ALSO grants lambda:InvokeFunction to * (in addition to
  // lambda:InvokeFunctionUrl above). AWS rejects --function-url-auth-type on
  // this action, so the statement is unconditioned. Verified empirically:
  // with only the InvokeFunctionUrl statement, every URL request returned
  // 403; adding this statement made the same URL return 200.
  const hasInvokeStatement = getPolicy.ok && getPolicy.stdout.includes("FunctionURLAllowPublicInvoke");
  if (!hasInvokeStatement) {
    log("adding public InvokeFunction permission (Oct 2025 requirement)...");
    const addInvoke = aws([
      "lambda",
      "add-permission",
      "--function-name",
      FUNCTION_NAME,
      "--action",
      "lambda:InvokeFunction",
      "--statement-id",
      "FunctionURLAllowPublicInvoke",
      "--principal",
      "*",
    ]);
    if (!addInvoke.ok && !/ResourceConflictException/i.test(addInvoke.stderr)) {
      return { ok: false, deniedReason: addInvoke.stderr };
    }
  }

  return { ok: true, functionUrl };
}

// --- Step E: reserved concurrency (cost ceiling) ----------------------------
// Idempotent: reads the current value first and only calls put-function-
// concurrency when it differs from RESERVED_CONCURRENCY.
async function ensureReservedConcurrency() {
  const get = aws(["lambda", "get-function-concurrency", "--function-name", FUNCTION_NAME, "--output", "json"]);
  // With no reservation configured the CLI prints an EMPTY body, not {} -
  // guard before parsing (observed live 2026-08-10).
  const current = get.ok && get.stdout.trim() ? JSON.parse(get.stdout).ReservedConcurrentExecutions : undefined;
  if (current === RESERVED_CONCURRENCY) {
    log(`reserved concurrency already set to ${RESERVED_CONCURRENCY}`);
    return { ok: true };
  }
  log(`setting reserved concurrency to ${RESERVED_CONCURRENCY} (cost ceiling)...`);
  const put = aws([
    "lambda",
    "put-function-concurrency",
    "--function-name",
    FUNCTION_NAME,
    "--reserved-concurrent-executions",
    String(RESERVED_CONCURRENCY),
  ]);
  if (!put.ok) return { ok: false, deniedReason: put.stderr };
  return { ok: true };
}

// --- main --------------------------------------------------------------------
async function main() {
  const env = readDotEnv();
  const cloudDbUrl = env.ENGRAM_CLOUD_DATABASE_URL;
  if (!cloudDbUrl) {
    console.error("[deploy-lambda] FAIL: ENGRAM_CLOUD_DATABASE_URL not set in .env");
    process.exitCode = 1;
    return;
  }

  try {
    const zipPath = await bundle();

    const role = await ensureRole();
    if (!role.ok) {
      console.error("[deploy-lambda] IAM step DENIED:");
      console.error(role.deniedReason);
      console.error(
        "\nOperator TODO (run manually with sufficient IAM permissions, or grant the h0 profile " +
          "iam:CreateRole / iam:AttachRolePolicy / iam:PutRolePolicy / iam:GetRole):\n" +
          `  1. Create role ${ROLE_NAME} trusting lambda.amazonaws.com\n` +
          "  2. Attach managed policy arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole\n" +
          "  3. Put an inline policy allowing bedrock:InvokeModel + bedrock:InvokeModelWithResponseStream on Resource *\n" +
          "  4. Re-run: node scripts/deploy-lambda.mjs"
      );
      process.exitCode = 1;
      return;
    }
    log(`role ready: ${role.roleArn}`);

    const fn = await ensureFunction(role.roleArn, role.created, zipPath, cloudDbUrl);
    if (!fn.ok) {
      console.error("[deploy-lambda] Lambda function step FAILED:");
      console.error(fn.deniedReason);
      process.exitCode = 1;
      return;
    }
    log(`function ready (created=${fn.created})`);

    const url = await ensureFunctionUrl();
    if (!url.ok) {
      console.error("[deploy-lambda] Function URL step FAILED:");
      console.error(url.deniedReason);
      process.exitCode = 1;
      return;
    }

    const concurrency = await ensureReservedConcurrency();
    if (!concurrency.ok) {
      console.error("[deploy-lambda] reserved concurrency step FAILED:");
      console.error(concurrency.deniedReason);
      process.exitCode = 1;
      return;
    }

    console.log(`\nFUNCTION_URL=${url.functionUrl}`);
    log("deploy complete");
  } finally {
    if (ownScratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[deploy-lambda] FAIL:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
