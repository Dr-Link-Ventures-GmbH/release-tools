// src/cli/release.js

import { execSync } from 'child_process';
import readline from 'readline';

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (e) {
    console.error(`❌ Command failed: ${cmd}`);
    process.exit(1);
  }
}

function execOut(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch (e) {
    console.error(`❌ Command failed: ${cmd}`);
    process.exit(1);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

const ENVIRONMENTS = ['development', 'testing', 'staging', 'production'];
const BUMPS = ['none', 'patch', 'minor', 'major'];

async function promptEnvironment() {
  const map = { "0": "development", "1": "testing", "2": "staging", "3": "production" };
  const answer = (await ask("🌍 Umgebung? (0=dev, 1=test, 2=stag, 3=prod): ")).trim().toLowerCase();
  if (map[answer]) return map[answer];
  if (ENVIRONMENTS.includes(answer)) return answer;
  console.log("⚠️ Ungültig, Default: staging");
  return "staging";
}


async function promptBump() {
  const map = { "0": "none", "1": "patch", "2": "minor", "3": "major" };
  const answer = (await ask("🔢 Versionssprung? (0=none, 1=patch, 2=minor, 3=major): ")).trim().toLowerCase();
  if (map[answer]) return map[answer];
  if (BUMPS.includes(answer)) return answer;
  console.log("⚠️ Ungültig, Default: patch");
  return "patch";
}


function ensureCleanWorkingTree() {
  const status = execOut('git status --porcelain');
  if (status) {
    console.error('❌ Working tree ist nicht clean. Bitte commit oder stash.');
    process.exit(1);
  }
}

function getVersionFromPackageJson() {
  const pkg = JSON.parse(
    execSync(
      "node -p \"JSON.stringify(require('./package.json'))\"",
      { stdio: 'pipe' }
    ).toString()
  );
  return pkg.version;
}

async function main() {
  const env = await promptEnvironment();
  const bump = await promptBump();

  console.log('🔎 Checking prerequisites ...');
  exec(`node node_modules/@betaos/release-tools/src/cli/check-prerequisites.js ${env}`);

  ensureCleanWorkingTree();

  console.log('🔄 Git pull...');
  exec('git checkout main');
  exec('git pull origin main');

  let version = getVersionFromPackageJson();

  if (bump !== 'none') {
    console.log(`🏷️ npm version ${bump} ...`);
    exec(`npm version ${bump}`);
    version = getVersionFromPackageJson();
  } else {
    console.log(`🔁 Reusing current version: ${version}`);
  }

  console.log('⬆️ Git push (inkl tags) ...');
  exec('git push origin main');
  exec('git push --tags');

  console.log('🏗️ Build dist ...');
  exec('npm run build');

  console.log(`🚀 Deploy (${env}) ...`);
  exec(`node node_modules/@betaos/release-tools/src/cli/deploy.js ${env}`);

  console.log(`✅ Done. Version: ${version}, Umgebung: ${env}`);
}

await main();
