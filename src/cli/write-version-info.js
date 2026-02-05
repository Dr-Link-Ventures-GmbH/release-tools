// src/cli/write-build-info.js
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

const projectRoot = process.cwd();

// Zielverzeichnis MUSS explizit gesetzt werden
const wwwDir = process.env.WWW_DIR
  ? path.resolve(projectRoot, process.env.WWW_DIR)
  : (() => {
      console.error("❌ WWW_DIR not set");
      process.exit(1);
    })();

const buildInfoPath = path.join(wwwDir, "build.info");

// Version-Quelle (klar definiert):
// 1) ENV VERSION (vom Release-CLI)
// 2) version.json
// 3) package.json
// 4) letzter Git-Tag
// 5) Fallback
function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const version =
  process.env.VERSION ||
  readJsonIfExists(path.join(projectRoot, "version.json"))?.version ||
  readJsonIfExists(path.join(projectRoot, "package.json"))?.version ||
  safeExec("git describe --tags --abbrev=0", null) ||
  "0.0.0";

// Git-Metadaten
const commit   = safeExec("git rev-parse --short HEAD", "unknown");
const branch   = safeExec("git rev-parse --abbrev-ref HEAD", "unknown");
const upstream = safeExec("git config --get remote.origin.url", "unknown");
const dirty    = !!safeExec("git status --porcelain", "");

// Zeit / Laufzeit
const buildInfo = {
  version,
  commit,
  branch,
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
  user: process.env.USER || process.env.USERNAME || "unknown",
  dirty,
  upstream
};

try {
  writeJsonFile(buildInfoPath, buildInfo);
  console.log(`📦 build.info written → ${path.relative(projectRoot, buildInfoPath)}`);
} catch (err) {
  console.error("❌ Failed to write build.info:", err?.message || err);
  process.exit(1);
}
