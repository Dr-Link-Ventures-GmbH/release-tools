// src/cli/release.js

import { execSync } from 'child_process';
import readline from 'readline';
import fs from 'fs';

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch {
    process.exit(1);
  }
}

function execOut(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch {
    process.exit(1);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    })
  );
}

const ENVIRONMENTS = ['development', 'testing', 'staging', 'production'];
const BUMPS = ['none', 'patch', 'minor', 'major'];

async function promptEnvironment() {
  const map = { "0": "development", "1": "testing", "2": "staging", "3": "production" };
  const answer = (await ask("🌍 Umgebung? (0=dev, 1=test, 2=stag, 3=prod): ")).trim();
  return map[answer] || answer || "staging";
}

async function promptBump() {
  const map = { "0": "none", "1": "patch", "2": "minor", "3": "major" };
  const answer = (await ask("🔢 Versionssprung? (0=none, 1=patch, 2=minor, 3=major): ")).trim();
  return map[answer] || answer || "patch";
}

function ensureCleanWorkingTree() {
  if (execOut('git status --porcelain')) {
    console.error('❌ Working tree ist nicht clean.');
    process.exit(1);
  }
}

function getVersionFromPackageJson() {
  return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
}

async function main() {
  const env  = await promptEnvironment();
  const bump = await promptBump();

  exec(`node node_modules/@betaos/release-tools/src/cli/check-prerequisites.js ${env}`);
  ensureCleanWorkingTree();

  exec('git checkout main');
  exec('git pull origin main');

  let version = getVersionFromPackageJson();

  if (bump !== 'none') {
    exec(`npm version ${bump}`);
    version = getVersionFromPackageJson();
  }

  exec('git push origin main');
  exec('git push --tags');

  exec('npm run build');

  // 🔥 EINZIGE Quelle der Wahrheit: build.info
  const wwwDir =
    env === 'development'
      ? 'localdev/www'
      : 'www';

  exec(
    'node node_modules/@betaos/release-tools/src/cli/write-build-info.js',
    {
      env: {
        ...process.env,
        VERSION: version,
        WWW_DIR: wwwDir
      }
    }
  );

  exec(`node node_modules/@betaos/release-tools/src/cli/deploy.js ${env}`);

  console.log(`✅ Done. Version: ${version}, Umgebung: ${env}`);
}

await main();
