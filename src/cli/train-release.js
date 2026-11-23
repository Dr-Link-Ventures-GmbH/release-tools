// src/cli/train-release.js — the release train (v0.7.0).
//
// Problem it solves: 5–10 agents work on the same product and each released its own commit. Releases queued behind
// one lock, the version commit on main collided with the other agents' pushes, killed agents left locks behind.
//
// Model ("ride along instead of queueing up"):
//   - An agent only pushes its commit to origin/<branch> and calls `release-train <target>`.
//   - Exactly one process at a time drives the train: whoever gets the server lock. The driver builds the CURRENT
//     tip of origin/<branch> — all commits pushed so far, from every agent — in a dedicated release clone where
//     nobody edits (projects/_release/<repo>), deploys it, tags it and writes the release state to the server.
//   - Everybody else waits and checks whether their commit is already contained in what is live. Then they are done
//     without building anything. Ten agents → one or two builds instead of ten.
//   - No version commit on the branch any more: the version (CalVer YYYY.M.PATCH) is computed from the highest tag,
//     written into package.json only inside the release clone (so vite/webpack see it) and pushed as a tag. Pushing a
//     tag never collides with somebody's push to main.
//   - A failed build of tip X is recorded; the other waiters stop instead of rebuilding the same broken X. The next
//     push (new tip) gets a fresh try.
//
// CLI: release-train <target> [--push] [--sha=<commit>] [--latest]
//   --push    HEAD not on origin yet: rebase onto origin/<branch> and push HEAD:<branch> (3 attempts)
//   --sha     wait for this commit instead of HEAD
//   --latest  release whatever origin/<branch> is now (default when run inside the release clone)
// Env: RELEASE_CLONE_DIR (override clone path), RELEASE_TRAIN_MAX_WAIT_MIN (default 90), RELEASE_FORCE=1 (as deploy).
//
// File name ends with "release.js" on purpose: project bootstraps load their SSH secrets only for that script name.

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { connectFromEnv } from '../core/ssh.js';
import { tryAcquireReleaseLock, compareVersions, q } from '../core/release-lock.js';
import { runDeploy } from './deploy.js';

const POLL_MS = 10_000;
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

const sh = (cmd, cwd, env) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env })
  .toString().trim();
const shTry = (cmd, cwd) => { try { return sh(cmd, cwd); } catch { return null; } };
const run = (cmd, cwd, env) => execSync(cmd, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: env ? { ...process.env, ...env } : process.env });
const t = () => new Date().toLocaleTimeString('de-DE');
const log = (...a) => console.log(`[${t()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, what, n = 4) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) { if (i >= n) throw e; log(`↻ ${what} failed (attempt ${i}) — retrying`); await sleep(3000 * i); }
  }
}

function calverNext(max) {
  const now = new Date();
  const [y, m, p] = String(max || '').split('.').map((n) => parseInt(n, 10));
  if (y === now.getFullYear() && m === now.getMonth() + 1) return `${y}.${m}.${(p || 0) + 1}`;
  return `${now.getFullYear()}.${now.getMonth() + 1}.0`;
}

function isAncestor(sha, of, cwd) {
  if (!sha || !of) return false;
  try { execSync(`git merge-base --is-ancestor ${sha} ${of}`, { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}

/** Resolve the release clone: projects/_release/<repo>, next to the main checkout's parent. */
function cloneDirFor(agentDir) {
  if (process.env.RELEASE_CLONE_DIR) return path.resolve(process.env.RELEASE_CLONE_DIR);
  const common = path.resolve(agentDir, sh('git rev-parse --git-common-dir', agentDir));
  const mainCheckout = path.dirname(common);
  const url = sh('git config --get remote.origin.url', agentDir);
  const repo = path.basename(url).replace(/\.git$/, '');
  // agent already sits inside a release clone (…/_release/<repo>)
  if (path.basename(path.dirname(mainCheckout)) === '_release') return mainCheckout;
  return path.join(path.dirname(mainCheckout), '_release', repo);
}

/** Local config the repo does not carry: .env* and every other git-ignored FILE in the project root
 *  (e.g. .google-service-account.json, which BetaOSBase's preinstall check requires) — never directories.
 *  Runs on every call and only fills in what is missing, so an interrupted first setup heals itself. */
function copyLocalConfig(cloneDir, agentDir) {
  const mainCheckout = path.dirname(path.resolve(agentDir, sh('git rev-parse --git-common-dir', agentDir)));
  for (const src of [...new Set([agentDir, mainCheckout])]) {
    if (path.resolve(src) === path.resolve(cloneDir)) continue;
    const ignored = (shTry('git ls-files --others --ignored --exclude-standard --directory', src) || '').split(/\r?\n/)
      .map((n) => n.trim()).filter((n) => n && !n.includes('/'));
    const names = new Set([...fs.readdirSync(src).filter((n) => n.startsWith('.env')), ...ignored]);
    for (const n of names) {
      if (n === '.env.example') continue;
      const from = path.join(src, n);
      let st; try { st = fs.statSync(from); } catch { continue; }
      if (!st.isFile() || st.size > 1_000_000) continue;
      if (!fs.existsSync(path.join(cloneDir, n))) { fs.copyFileSync(from, path.join(cloneDir, n)); log(`📄 copied ${n} into the release clone`); }
    }
  }
}

async function ensureClone(cloneDir, agentDir) {
  // ready = cloned AND one successful dependency install (stamp written afterwards) — a half-finished
  // node_modules from an interrupted first install does not count
  const stamp = path.join(cloneDir, 'node_modules', '.release-train-lock');
  const ready = () => fs.existsSync(path.join(cloneDir, '.git')) && fs.existsSync(stamp);
  if (fs.existsSync(path.join(cloneDir, '.git'))) copyLocalConfig(cloneDir, agentDir);
  if (ready()) return;
  const busy = `${cloneDir}.creating`;
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  try { fs.mkdirSync(busy); } catch {
    log(`⏳ Release clone ${cloneDir} is being set up by another agent — waiting…`);
    while (!ready() && fs.existsSync(busy)) await sleep(5000);
    return;
  }
  try {
    if (!fs.existsSync(path.join(cloneDir, '.git'))) {
      const url = sh('git config --get remote.origin.url', agentDir);
      log(`📥 Creating release clone ${cloneDir}`);
      run(`git clone "${url}" "${cloneDir}"`, path.dirname(cloneDir));
    }
    copyLocalConfig(cloneDir, agentDir);
    log('📦 Installing dependencies in the release clone');
    run('npm install --no-audit --no-fund', cloneDir);
    const lockFile = path.join(cloneDir, 'package-lock.json');
    fs.writeFileSync(stamp, fs.existsSync(lockFile) ? sh(`git hash-object "${lockFile}"`, cloneDir) : 'none');
  } finally { fs.rmSync(busy, { recursive: true, force: true }); }
}

async function loadBootstrap(cloneDir) {
  process.chdir(cloneDir);
  const p = path.join(cloneDir, 'scripts', 'bootstrap.js');
  if (!fs.existsSync(p)) throw new Error(`Project bootstrap not found: ${p}`);
  // a driver may be reinstalling node_modules in the clone right now (lockfile changed): wait and retry
  for (let i = 1; ; i++) {
    try { return await (await import(`${pathToFileURL(p).href}?t=${Date.now()}`)).default; }
    catch (e) {
      if (i >= 20 || !/Cannot find (module|package)/.test(String(e?.message))) throw e;
      if (i === 1) log('⏳ Release clone is reinstalling its dependencies — waiting…');
      await sleep(15_000);
    }
  }
}

const statePath = (b, target) => `${b.REMOTE_BASE_PATH.replace(/\/+$/, '')}/.release-state-${target}.json`;

async function readState(ssh, b, target) {
  const r = await ssh.execCommand(`cat ${q(statePath(b, target))} 2>/dev/null`);
  let state = {};
  try { state = JSON.parse(r.stdout); } catch { /* none yet */ }
  if (!state.commit) {
    // fallback for the first train run: what an earlier release deployed (build.info of the first dir item)
    const item = b.DEPLOY_ITEMS.find((i) => i.isDir);
    if (item) {
      const dir = `${b.REMOTE_BASE_PATH}${target}${item.remoteSubdir ? `/${item.remoteSubdir}` : ''}`;
      const bi = await ssh.execCommand(`cat ${q(dir + '/build.info')} 2>/dev/null`);
      try { const j = JSON.parse(bi.stdout); state.commit = j.commit; state.version = j.version; } catch { /* nothing */ }
    }
  }
  return state;
}

async function writeState(ssh, b, target, patch) {
  const cur = await readState(ssh, b, target);
  const next = { ...cur, ...patch };
  await ssh.execCommand(`printf %s ${q(JSON.stringify(next))} > ${q(statePath(b, target) + '.tmp')} && mv ${q(statePath(b, target) + '.tmp')} ${q(statePath(b, target))}`);
  return next;
}

/** Driver: build the current tip in the release clone and deploy it. Runs only while holding the lock. */
async function drive(ssh, b0, cloneDir, target) {
  let b = b0;
  const branch = b.REPO_BRANCH;
  run('git fetch origin --tags --force --prune --quiet', cloneDir);
  run(`git checkout -q -f ${branch}`, cloneDir);
  run(`git reset -q --hard origin/${branch}`, cloneDir);
  const tip = sh('git rev-parse HEAD', cloneDir);
  // the project bootstrap may have changed with the commits just pulled (deploy items, secrets): load it fresh
  b = { ...(await loadBootstrap(cloneDir)), target };

  const state = await readState(ssh, b, target);
  if (state.commit && isAncestor(tip, state.commit, cloneDir)) { log(`✅ ${tip.slice(0, 7)} is already live (${state.version}).`); return; }
  if (state.failed?.commit === tip) {
    throw new Error(`Tip ${tip.slice(0, 7)} already failed (${state.failed.host}, ${state.failed.at}): ${state.failed.error} — push a fix, then release again.`);
  }

  // dependencies: npm ci only when the lockfile changed since the last install in this clone
  const lockFile = ['package-lock.json', 'npm-shrinkwrap.json'].map((f) => path.join(cloneDir, f)).find(fs.existsSync);
  const want = lockFile ? sh(`git hash-object "${lockFile}"`, cloneDir) : 'none';
  const stamp = path.join(cloneDir, 'node_modules', '.release-train-lock');
  const have = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
  if (want !== have) {
    log('📦 Lockfile changed — npm install');
    // npm install, not npm ci: ci wipes node_modules first, and riders load the project bootstrap from there
    run('npm install --no-audit --no-fund', cloneDir);
    fs.writeFileSync(stamp, want);
  }

  // version: highest tag (or package.json on the branch, whichever is higher) + 1, CalVer
  const pkg = JSON.parse(fs.readFileSync(b.PACKAGE_JSON_FILE, 'utf8'));
  const tags = sh('git tag -l "v*"', cloneDir).split('\n').map((s) => s.replace(/^v/, '')).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const max = [pkg.version, ...tags].reduce((a, v) => (compareVersions(v, a) > 0 ? v : a), '0.0.0');
  let version = calverNext(max);
  while (tags.includes(version)) version = calverNext(version);
  const commits = state.commit && shTry(`git rev-list --count ${state.commit}..HEAD`, cloneDir);
  log(`🚂 Driving ${version} = ${tip.slice(0, 7)}${commits ? ` (${commits} commits since ${state.version})` : ''}`);
  let releaseCommit = tip;
  // last live commit for diff-scoped validation (release tags sit on side commits, `git describe` can't see them)
  const prevEnv = state.commit ? { RELEASE_PREV_COMMIT: String(state.commit) } : {};
  try {
    // bundlers read the version from package.json; the project's "version" script runs too (e.g. pyproject.toml).
    // The change becomes a release commit on top of the tip that only the TAG carries — never pushed to the branch,
    // so it cannot collide with other agents. Builds from the committed tree (git archive HEAD) see it as well.
    run(`npm version ${version} --no-git-tag-version --allow-same-version`, cloneDir);
    if (sh('git status --porcelain --untracked-files=no', cloneDir)) {
      run(`git commit -q -a --no-verify -m "release v${version}"`, cloneDir);
      releaseCommit = sh('git rev-parse HEAD', cloneDir);
    }
    let validation = null;
    const validateCmd = process.env.RELEASE_VALIDATE_CMD || b.VALIDATE_CMD;
    if (validateCmd) {
      log(`🧪 Validation in parallel: ${validateCmd}`);
      validation = new Promise((res, rej) => spawn(validateCmd, { cwd: cloneDir, shell: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...prevEnv } })
        .on('close', (c) => (c === 0 ? res() : rej(new Error(`Validation failed (${validateCmd}, exit ${c})`)))));
      validation.catch(() => {});
    }
    run('npm run build', cloneDir, { BUILD_TARGET: target, ...prevEnv });
    if (validation) await validation;
    const here = path.dirname(fileURLToPath(import.meta.url));
    run(`node "${path.join(here, 'write-version-info.js')}"`, cloneDir, { VERSION: version, DIST_DIR: b.DIST_DIR });
  } catch (e) {
    await writeState(ssh, b, target, { failed: { commit: tip, version, host: os.hostname(), at: new Date().toISOString(), error: String(e.message).slice(0, 300) } });
    throw e;
  }

  // reserve the version before the deploy: a tag push never collides with other agents' pushes to the branch
  run(`git tag v${version} ${releaseCommit}`, cloneDir);
  run(`git push -q --no-verify origin refs/tags/v${version}`, cloneDir);   // validated above, skip pre-push hooks

  await runDeploy({ ...b, packageJson: { ...pkg, version } });
  await writeState(ssh, b, target, { commit: tip, version, deployedAt: new Date().toISOString(), host: os.hostname(), failed: null });
  log(`🚀 ${version} (${tip.slice(0, 7)}) is live on ${target}.`);
}

async function main() {
  const agentDir = process.cwd();
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) throw new Error('Usage: release-train <target> [--push] [--sha=<commit>] [--latest]');

  const cloneDir = cloneDirFor(agentDir);
  const inClone = path.resolve(agentDir) === path.resolve(cloneDir);
  await ensureClone(cloneDir, agentDir);
  const b = await loadBootstrap(cloneDir);
  if (!b.target) b.target = target;
  if (b.target !== target) throw new Error(`Target mismatch: ${b.target} vs ${target}`);
  if (!fs.existsSync(b.ENV_FILE)) throw new Error(`Missing ${b.ENV_FILE} in the release clone — copy it there once.`);
  const branch = b.REPO_BRANCH;

  // which commit do we wait for?
  const gitDir = inClone ? cloneDir : agentDir;   // the clone belongs to the driver; read-only use here
  // worktrees share one repository with the release clone's driver: a concurrent fetch can hit a ref lock — retry
  if (!inClone) await retry(() => run(`git fetch -q origin ${branch}`, agentDir), 'fetch');
  let want = opt('sha') ? sh(`git rev-parse ${opt('sha')}`, gitDir) : null;
  if (!want && (flag('latest') || inClone)) want = sh(`git ls-remote origin refs/heads/${branch}`, gitDir).split(/\s/)[0];
  if (!want) {
    want = sh('git rev-parse HEAD', agentDir);
    if (!isAncestor(want, `origin/${branch}`, agentDir)) {
      if (!flag('push')) throw new Error(`HEAD ${want.slice(0, 7)} is not on origin/${branch} — push it first (or call with --push).`);
      if (sh('git status --porcelain --untracked-files=no', agentDir)) throw new Error('Uncommitted changes — commit first.');
      for (let i = 1; ; i++) {
        try {
          try { run(`git pull -q --rebase origin ${branch}`, agentDir); }
          catch (e) {
            const midRebase = ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.resolve(agentDir, sh(`git rev-parse --git-path ${d}`, agentDir))));
            if (!midRebase) throw e;   // fetch/ref-lock trouble, not a conflict → retried below
            shTry('git rebase --abort', agentDir);
            throw Object.assign(new Error(`Rebase onto origin/${branch} has conflicts — resolve them in ${agentDir}, commit, then run again.`), { fatal: true });
          }
          run(`git push -q origin HEAD:${branch}`, agentDir);
          break;
        }
        catch (e) { if (e.fatal || i >= 3) throw e; log(`↻ Push rejected (attempt ${i}) — retrying`); }
      }
      want = sh('git rev-parse HEAD', agentDir);
      log(`⬆️  Pushed ${want.slice(0, 7)} to origin/${branch}`);
    }
  }
  if (!inClone && !isAncestor(want, `origin/${branch}`, agentDir)) throw new Error(`${want.slice(0, 7)} is not on origin/${branch}.`);
  log(`🎫 Waiting for ${want.slice(0, 7)} to be live on ${target} (train ${cloneDir})`);

  const maxWait = Number(process.env.RELEASE_TRAIN_MAX_WAIT_MIN || 90) * 60_000;
  const start = Date.now();
  const ssh = await connectFromEnv(b.ENV_FILE);
  let lastHeld = '';
  try {
    for (;;) {
      const state = await readState(ssh, b, target);
      // the live commit may be newer than our last fetch (another machine drove): fetch once if it is unknown here
      const contained = (sha) => {
        if (!inClone && shTry(`git cat-file -e ${sha}`, gitDir) === null) shTry(`git fetch -q origin ${branch}`, agentDir);
        return isAncestor(want, sha, gitDir);
      };
      if (state.commit && contained(state.commit)) {
        log(`✅ ${want.slice(0, 7)} is live on ${target} in ${state.version} (${String(state.commit).slice(0, 7)}).`);
        return;
      }
      // a recorded failure only stops us while it is still the tip — a newer push gets a fresh build
      const tipNow = state.failed?.commit && shTry(`git ls-remote origin refs/heads/${branch}`, gitDir)?.split(/\s/)[0];
      if (state.failed?.commit && state.failed.commit === tipNow && contained(state.failed.commit)) {
        throw new Error(`Build of ${state.failed.commit.slice(0, 7)} (contains your commit) failed on ${state.failed.host}: ${state.failed.error}`);
      }

      const lockSsh = await connectFromEnv(b.ENV_FILE);
      const r = await tryAcquireReleaseLock(lockSsh, { REMOTE_BASE_PATH: b.REMOTE_BASE_PATH, target, log });
      if (r.lock) {
        try { await drive(lockSsh, b, cloneDir, target); }
        finally { await r.lock.release(); }
        continue;   // re-check: our commit is normally part of what we just built
      }
      lockSsh.dispose();
      if (Date.now() - start > maxWait) throw new Error(`Timed out waiting for the release train (held by ${r.held}).`);
      if (r.held !== lastHeld) { log(`⏳ Train is running (${r.held}, ${r.age}s) — your commit rides along or goes with the next one.`); lastHeld = r.held; }
      await sleep(POLL_MS);
    }
  } finally { ssh.dispose(); }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`[${t()}] ❌ Release train failed:`, err?.message ?? err);
  process.exit(1);
});
