// scripts/write-version-info.js
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

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readJsonIfExists(p) {
  if (!fileExists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeTextFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function writeJsonFile(targetPath, obj) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

const projectRoot = process.cwd();

// Ziel: www/version.info (default) und optional www/build.info
const wwwDir = process.env.WWW_DIR
  ? path.resolve(projectRoot, process.env.WWW_DIR)
  : path.resolve(projectRoot, "www");

const versionInfoPath = process.env.VERSION_INFO_FILE
  ? path.resolve(projectRoot, process.env.VERSION_INFO_FILE)
  : path.join(wwwDir, "version.info");

const buildInfoPath = process.env.BUILD_INFO_FILE
  ? path.resolve(projectRoot, process.env.BUILD_INFO_FILE)
  : path.join(wwwDir, "build.info");

// Version-Quelle (Reihenfolge):
// 1) ENV VERSION
// 2) version.json { "version": "x.y.z" }
// 3) package.json { "version": "x.y.z" } (falls vorhanden)
// 4) git describe --tags --abbrev=0
// 5) fallback: "0.0.0"
const envVersion = (process.env.VERSION || "").trim();

const versionJson = readJsonIfExists(path.join(projectRoot, "version.json"));
const packageJson = readJsonIfExists(path.join(projectRoot, "package.json"));

const lastTag = safeExec("git describe --tags --abbrev=0", null);

const version =
  envVersion ||
  (versionJson && typeof versionJson.version === "string" && versionJson.version.trim()) ||
  (packageJson && typeof packageJson.version === "string" && packageJson.version.trim()) ||
  lastTag ||
  "0.0.0";

// Git Metadaten
const commit = safeExec("git rev-parse --short HEAD", "unknown");
const branch = safeExec("git rev-parse --abbrev-ref HEAD", "unknown");
const upstream = safeExec("git config --get remote.origin.url", "unknown");
const dirty = !!safeExec("git status --porcelain", "");

// Zeit
const builtAt = new Date().toISOString();

// Optional: Changes seit letztem Tag
const changes =
  lastTag
    ? safeExec(`git log ${lastTag}..HEAD --pretty=format:"%h %s"`, "")
        .split("\n")
        .filter(Boolean)
    : [];

try {
  // version.info als Plaintext, so wie man es gerne minimalistisch ausliest
  writeTextFile(versionInfoPath, `${version}\n`);

  // build.info als JSON (optional, aber sehr praktisch)
  const buildInfo = {
    version,
    commit,
    branch,
    builtAt,
    nodeVersion: process.version,
    user: process.env.USER || process.env.USERNAME || "unknown",
    dirty,
    upstream,
    lastTag: lastTag || "(none)",
    changes
  };

  writeJsonFile(buildInfoPath, buildInfo);

  console.log(`📦 version.info → ${path.relative(projectRoot, versionInfoPath)} (${version})`);
  console.log(`📦 build.info   → ${path.relative(projectRoot, buildInfoPath)} (${commit})`);
} catch (err) {
  console.error("❌ Failed to write version/build info:", err?.message || err);
  process.exit(1);
}
