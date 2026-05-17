// src/cli/release.js
//
// Release flow for projects using @linkventures/release-tools:
//   1. Verify prerequisites (.env.<target> present)
//   2. Switch to repo branch, pull --rebase, optionally merge feature branch
//   3. Bump version (CalVer for --patch: YYYY.M.PATCH, npm semver for minor/major)
//   4. npm run build (BUILD_TARGET env exposes the target to vite/webpack)
//   5. Write dist/build.info
//   6. Deploy (runDeploy)
//   7. Push commits + tags, optionally delete merged feature branch
//
// CLI args: <target> [--bump=patch|minor|major|none] [--patch|--minor|--major]
//           [--branch=<name>|--branch=none] [--no-git] [--silent]
//
// Missing target/bump are prompted interactively. --no-git skips git
// operations (useful for re-deploying the current build without bumping).

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import readline from 'readline';
import loadProjectBootstrap from '../core/load-project-bootstrap.js';
import { runDeploy } from './deploy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, env) {
  execSync(cmd, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function out(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

const BUMP_MAP = {
  '0': 'none', '1': 'patch', '2': 'minor', '3': 'major',
  none: 'none', patch: 'patch', minor: 'minor', major: 'major',
};

/**
 * CalVer next-version: YYYY.M.PATCH.
 * - Same calendar month → bump patch (2026.5.3 → 2026.5.4).
 * - New month → reset patch to 0 (2026.5.99 → 2026.6.0).
 * - Migrating from a non-CalVer scheme → start at <year>.<month>.0.
 */
function calverNextVersion(currentVersion) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = now.getMonth() + 1;
  const parts = String(currentVersion || '').split('.').map(s => parseInt(s, 10));
  const [curY, curM, curP] = parts;
  if (curY >= 2000 && curY === yyyy && curM === mm) {
    return `${yyyy}.${mm}.${(curP || 0) + 1}`;
  }
  return `${yyyy}.${mm}.0`;
}

function resolveBumpArg(args) {
  for (const arg of args) {
    if (BUMP_MAP[arg]) return BUMP_MAP[arg];
    const m = arg.match(/^--bump=(.+)$/);
    if (m && BUMP_MAP[m[1]]) return BUMP_MAP[m[1]];
    if (arg === '--patch') return 'patch';
    if (arg === '--minor') return 'minor';
    if (arg === '--major') return 'major';
  }
  return null;
}

async function resolveBump(args) {
  const fromArg = resolveBumpArg(args);
  if (fromArg) return fromArg;
  while (true) {
    const raw = await ask('🔢 Version bump? (0=none, 1=patch, 2=minor, 3=major): ');
    const type = BUMP_MAP[raw];
    if (type) return type;
    console.log('❌ Invalid input.');
  }
}

function resolveBranchArg(args) {
  for (const arg of args) {
    const m = arg.match(/^--branch=(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

async function resolveBranch(args) {
  const fromArg = resolveBranchArg(args);
  if (fromArg !== null) return fromArg === 'none' ? null : fromArg;
  const raw = await ask('🌿 Branch mergen? (Enter = keiner, oder Branchname): ');
  return raw || null;
}

function ensureCleanGit() {
  const status = out('git status --porcelain');
  if (status) {
    console.error('❌ Working tree not clean:');
    console.error(status);
    process.exit(1);
  }
}

function getCurrentVersion(packageJsonFile) {
  return JSON.parse(readFileSync(packageJsonFile, 'utf8')).version;
}

async function main() {
  const bootstrap = await loadProjectBootstrap();
  const {
    PACKAGE_JSON_FILE,
    DIST_DIR,
    REPO_BRANCH,
    args,
    flags,
    target,
  } = bootstrap;

  if (!target) {
    console.error('❌ No target specified (and interactive prompt was skipped).');
    process.exit(1);
  }

  // 1. Prerequisites (.env.<target>, etc.)
  run(`node "${path.join(__dirname, 'check-prerequisites.js')}" ${target}`);

  // 2. Git: switch to release branch, pull, optional merge
  if (!flags.noGit) {
    run(`git checkout ${REPO_BRANCH}`);
    run(`git fetch --tags`);
    run(`git pull --rebase origin ${REPO_BRANCH}`);

    const branch = await resolveBranch(args);
    if (branch) {
      console.log(`🔀 Merging branch: ${branch}`);
      run(`git merge --no-edit ${branch}`);
    }

    ensureCleanGit();

    const currentBranch = out('git rev-parse --abbrev-ref HEAD');
    if (currentBranch !== REPO_BRANCH) {
      console.error(`❌ Release must run on '${REPO_BRANCH}' (currently on '${currentBranch}').`);
      process.exit(1);
    }
  } else {
    console.log('⚠️  Git update skipped (--no-git)');
  }

  // 3. Version bump
  const bump = await resolveBump(args);
  let version = getCurrentVersion(PACKAGE_JSON_FILE);

  if (bump !== 'none' && !flags.noGit) {
    if (bump === 'patch') {
      const next = calverNextVersion(version);
      // npm version writes both package.json and package-lock.json + creates commit + tag
      run(`npm version ${next}`);
    } else {
      run(`npm version ${bump}`);
    }
    version = getCurrentVersion(PACKAGE_JSON_FILE);
  } else if (bump !== 'none' && flags.noGit) {
    console.log('⚠️  Bump requested but --no-git is set; reusing current version.');
  } else {
    console.log(`🔁 Reusing current version: ${version}`);
  }

  // 4. Build (BUILD_TARGET lets vite/webpack adjust behaviour per env)
  run('npm run build', { BUILD_TARGET: target });

  // 5. dist/build.info
  run(`node "${path.join(__dirname, 'write-version-info.js')}"`, {
    VERSION: version,
    DIST_DIR,
  });

  // 6. Deploy (re-load bootstrap so it picks up the bumped package.json)
  const deployBootstrap = await (await import('../core/load-project-bootstrap.js')).default();
  await runDeploy(deployBootstrap);

  // 7. Push commits + tags
  if (!flags.noGit) {
    run(`git push origin ${REPO_BRANCH} --tags`);

    const branch = resolveBranchArg(args);
    if (branch && branch !== 'none') {
      const del = await ask(`🗑  Branch '${branch}' löschen? (j/N): `);
      if (del.toLowerCase() === 'j') {
        run(`git branch -d ${branch}`);
        run(`git push origin --delete ${branch}`);
        console.log(`🗑  Branch '${branch}' gelöscht.`);
      }
    }
  }

  console.log(`✅ Release ${version} → ${target} completed.`);
}

await main();
