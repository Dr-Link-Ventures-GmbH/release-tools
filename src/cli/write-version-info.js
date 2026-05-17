// src/cli/write-version-info.js
//
// Writes <DIST_DIR>/build.info with package version, git metadata and
// build timestamp. Called from release.js after `npm run build` so the
// file ends up in the deployed bundle.

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

function safeExec(cmd, fallback = null) {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch {
    return fallback;
  }
}

function writeJsonFile(targetPath, obj) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const projectRoot = process.cwd();

// Output directory: explicit override via DIST_DIR env (set by release.js
// from the project bootstrap), otherwise default to ./dist
const distDir = process.env.DIST_DIR
  ? path.resolve(projectRoot, process.env.DIST_DIR)
  : path.join(projectRoot, "dist");

const buildInfoPath = path.join(distDir, "build.info");

// Version source priority:
// 1) ENV VERSION (passed by release.js)
// 2) version.json
// 3) package.json
// 4) latest git tag
// 5) fallback
const version =
  process.env.VERSION ||
  readJsonIfExists(path.join(projectRoot, "version.json"))?.version ||
  readJsonIfExists(path.join(projectRoot, "package.json"))?.version ||
  safeExec("git describe --tags --abbrev=0", null) ||
  "0.0.0";

const commit   = safeExec("git rev-parse --short HEAD", "unknown");
const branch   = safeExec("git rev-parse --abbrev-ref HEAD", "unknown");
const upstream = safeExec("git config --get remote.origin.url", "unknown");
const dirty    = !!safeExec("git status --porcelain", "");

const buildInfo = {
  version,
  commit,
  branch,
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
  user: process.env.USER || process.env.USERNAME || "unknown",
  dirty,
  upstream,
};

try {
  writeJsonFile(buildInfoPath, buildInfo);
  console.log(`📦 build.info written → ${path.relative(projectRoot, buildInfoPath)}`);
} catch (err) {
  console.error("❌ Failed to write build.info:", err?.message || err);
  process.exit(1);
}
