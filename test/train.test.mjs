// test/train.test.mjs — end-to-end test of the release train against a throwaway target on alpha.
//
//   npm test                    (from the release-tools repo, on a machine with alpha access)
//   ONLY=5 npm test             (scenario 1 + a subset)
//
// Builds a dummy project in a temp dir: a local bare repo as "origin", a main checkout, worktrees as agents, a
// release clone created by the train itself, and a deploy target /home/temruk/rt-test/ on alpha (no sudo, no
// Apache, no product touched). The project depends on a packed copy of THIS working tree (npm pack), so the code
// under test is exactly what is checked out here. Scenarios — each one a bug or a promise of the train:
//   1. four agents push and release at once, the release clone does not exist yet (clone setup race, 0.7.6/0.7.8:
//      the git-ignored config the preinstall check needs is copied) → all live, fewer builds than agents,
//      versions only as tags, no release commit on main
//   2. a driver is killed mid-build → the next one breaks the dead lock via heartbeat and releases
//   3. a broken build of main is remembered → a rider fails fast without rebuilding; a fix push heals it
//   4. a rebase conflict on --push aborts cleanly (no rebase left in progress)
//   5. a commit that changes the bootstrap is deployed with the NEW bootstrap (0.7.5)
//   6. the old path (release.js, deploy.js) is refused in a train project (0.8.0)
// Everything is removed afterwards (temp dir, remote dir) unless KEEP=1.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAIN = path.join(ROOT, 'src', 'cli', 'train-release.js');
const A = require(process.env.ALPHA_CREDS || 'C:/Users/mail/projects/Claude/alpha-creds.cjs');
const REMOTE = '/home/temruk/rt-test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
const fwd = (p) => p.replaceAll('\\', '/');

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what) { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) failures++; }

async function remote(cmd) {
  const ssh = await A.connect();
  try { return (await ssh.execCommand(cmd)).stdout.trim(); } finally { ssh.dispose(); }
}

/** One agent's train run; resolves with { code, out }. */
function train(cwd, args, env = {}) {
  let out = '';
  const child = spawn(process.execPath, [TRAIN, 'test', ...args], {
    cwd, env: { ...process.env, RELEASE_TRAIN_POLL_MS: '2000', RELEASE_CLONE_DIR: fwd(path.join(TMP, '_release', 'proj')), ...env },
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((res) => child.on('close', (code) => res({ code, out })));
  return { child, done, get out() { return out; } };
}
const builds = (runs) => runs.reduce((n, r) => n + (r.out.match(/🚂 Driving/g) || []).length, 0);

function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  sh(`git add -A && git commit -q -m "${msg}"`, dir);
}
function removeAndCommit(dir, file, msg) { sh(`git rm -q ${file} && git commit -q -m "${msg}"`, dir); }

function agent(name) {
  const dir = path.join(TMP, `agent-${name}`);
  sh(`git fetch -q origin && git worktree add -q "${fwd(dir)}" -b agent/${name} origin/main`, path.join(TMP, 'main'));
  return dir;
}

async function setup() {
  console.log(`🧪 temp: ${TMP}`);
  const tgz = sh(`npm pack --silent --pack-destination "${fwd(TMP)}"`, ROOT).split('\n').pop();
  sh(`git init -q --bare -b main origin.git`, TMP);
  const main = path.join(TMP, 'main');
  sh(`git clone -q "${fwd(path.join(TMP, 'origin.git'))}" main`, TMP);
  fs.mkdirSync(path.join(main, 'scripts'));
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({
    name: 'rt-test', version: '2026.1.0', private: true, type: 'module',
    scripts: {
      // 0.7.8: the release clone needs this git-ignored file before npm install even starts
      preinstall: "node -e \"require('fs').accessSync('.env.test')\"",
      build: 'node build.mjs',
    },
    dependencies: { '@linkventures/release-tools': `file:${fwd(path.join(TMP, tgz))}` },   // absolute: main checkout and release clone sit at different depths
  }, null, 2));
  fs.writeFileSync(path.join(main, 'build.mjs'), [
    "import fs from 'node:fs';",
    "if (fs.existsSync('FAIL_BUILD')) { console.error('build broken on purpose'); process.exit(1); }",
    "if (fs.existsSync('SLOW_BUILD')) await new Promise((r) => setTimeout(r, 90_000));",
    "const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;",
    "fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.txt', v + '\\n');",
  ].join('\n'));
  fs.writeFileSync(path.join(main, 'scripts', 'bootstrap.js'), bootstrapSource([]));
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\ndist/\n.env.test\n');
  fs.writeFileSync(path.join(main, '.env.test'), `SSH_USER=temruk\nSSH_KEY=${fwd(path.join(os.homedir(), '.ssh', 'temruk@alpha.irenia.de.ed25519'))}\n`);
  // the release clone is a sibling of the main checkout's parent: <TMP>/_release/proj (RELEASE_CLONE_DIR)
  sh('npm install --no-audit --no-fund --silent && git add -A && git commit -q -m init && git push -q origin main', main);
  await remote(`rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
}

function bootstrapSource(postDeploy) {
  return `import { createRequire } from 'node:module';
import makeBootstrap from '@linkventures/release-tools/src/core/bootstrap-factory.js';
const require = createRequire(import.meta.url);
const A = require(${JSON.stringify(fwd(process.env.ALPHA_CREDS || 'C:/Users/mail/projects/Claude/alpha-creds.cjs'))});
process.env.SSH_HOST = A.host;
process.env.SSH_PASSPHRASE = A.pass();
export default makeBootstrap({
  remoteBasePath: '${REMOTE}/',
  validTargets: ['test'],
  defaultTarget: 'test',
  deployItems: [{ path: 'dist', isDir: true, remoteSubdir: 'dist' }],
  postDeployCommands: ${JSON.stringify(postDeploy)},
});
`;
}

async function scenarioParallel() {
  console.log('\n1. Vier Agenten gleichzeitig, Release-Klon existiert noch nicht');
  const dirs = ['a', 'b', 'c', 'd'].map(agent);
  dirs.forEach((d, i) => commit(d, `feature-${i}.txt`, `${i}\n`, `feature ${i}`));
  const runs = dirs.map((d) => train(d, ['--push']));
  const res = await Promise.all(runs.map((r) => r.done));
  check(res.every((r) => r.code === 0), `alle vier fertig (Exitcodes ${res.map((r) => r.code).join(',')})`);
  if (res.some((r) => r.code !== 0)) res.forEach((r, i) => r.code && console.log(`--- agent ${i}\n${r.out.slice(-1500)}`));
  const n = builds(runs);
  check(n >= 1 && n < 4, `weniger Builds als Agenten (${n})`);
  const live = await remote(`cat ${REMOTE}/test/dist/index.txt`);
  const tip = sh('git rev-parse main', path.join(TMP, 'origin.git'));
  const state = JSON.parse((await remote(`cat ${REMOTE}/.release-state-test.json`)) || '{}');
  check(state.commit === tip, `live = Spitze von main (${String(state.commit).slice(0, 7)})`);
  check(live === state.version, `ausgelieferte Version ${live} = Tag-Version`);
  const subjects = sh('git log main --format=%s', path.join(TMP, 'origin.git'));
  check(!/^release v/m.test(subjects), 'kein Release-Commit auf main');
  check(sh('git tag -l "v*"', path.join(TMP, 'origin.git')).split('\n').filter(Boolean).length === n, 'ein Tag je Build');
  check(fs.existsSync(path.join(TMP, '_release', 'proj', '.env.test')), 'ignorierte Konfiguration in den Klon kopiert');
}

async function scenarioKilledDriver() {
  console.log('\n2. Fahrer wird mitten im Build abgeschossen');
  const dir = agent('slow');
  commit(dir, 'SLOW_BUILD', '1\n', 'slow build');
  const run = train(dir, ['--push']);
  for (let i = 0; i < 120 && !/🚂 Driving/.test(run.out); i++) await sleep(1000);
  check(/🚂 Driving/.test(run.out), 'langsamer Build läuft');
  // kill the whole tree (the build is a grandchild): a dead agent, as after a tool timeout
  if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${run.child.pid}`, { stdio: 'ignore' });
  else run.child.kill('SIGKILL');
  await run.done;
  removeAndCommit(dir, 'SLOW_BUILD', 'fast again');
  const t0 = Date.now();
  const next = train(dir, ['--push'], { RELEASE_LOCK_HEARTBEAT_STALE_MIN: '0.5' });
  const r = await next.done;
  check(r.code === 0, `nächster Lauf übernimmt und released (${Math.round((Date.now() - t0) / 1000)} s)`);
  check(/Breaking dead release lock/.test(r.out), 'toter Lock per Herzschlag erkannt');
}

async function scenarioBrokenBuild() {
  console.log('\n3. Kaputter Build von main');
  const dir = agent('broken');
  commit(dir, 'FAIL_BUILD', '1\n', 'break the build');
  const first = await train(dir, ['--push']).done;
  check(first.code !== 0 && /build broken on purpose|Command failed/.test(first.out), 'Fahrer scheitert am Build');
  const rider = train(dir, ['--latest']);
  const second = await rider.done;
  check(second.code !== 0 && !/🚂 Driving/.test(second.out) && /failed/.test(second.out), 'Mitfahrer bricht sofort ab, ohne neu zu bauen');
  removeAndCommit(dir, 'FAIL_BUILD', 'fix the build');
  const third = await train(dir, ['--push']).done;
  check(third.code === 0, 'nach dem Fix wieder live');
}

async function scenarioConflict() {
  console.log('\n4. Rebase-Konflikt bei --push');
  const x = agent('x');
  const y = agent('y');
  commit(x, 'shared.txt', 'from x\n', 'x edits shared');
  commit(y, 'shared.txt', 'from y\n', 'y edits shared');
  check((await train(x, ['--push']).done).code === 0, 'erster Agent released');
  const r = await train(y, ['--push']).done;
  check(r.code !== 0 && /conflicts/.test(r.out), 'zweiter Agent bekommt Konfliktmeldung');
  const mid = ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.resolve(y, sh(`git rev-parse --git-path ${d}`, y))));
  check(!mid, 'kein halber Rebase im Worktree');
}

async function scenarioBootstrapChange() {
  console.log('\n5. Commit ändert die Projekt-Konfiguration');
  const dir = agent('boot');
  const marker = `${REMOTE}/marker-${Date.now()}`;
  commit(path.join(dir), 'scripts/bootstrap.js', bootstrapSource([`touch ${marker}`]), 'post-deploy marker');
  const r = await train(dir, ['--push']).done;
  check(r.code === 0, 'released');
  check((await remote(`test -f ${marker} && echo yes`)) === 'yes', 'neuer Post-Deploy-Befehl wurde ausgeführt');
}

async function scenarioLegacyRefused() {
  console.log('\n6. Alter Weg (release.js / deploy.js) in einem Zug-Projekt');
  const main = path.join(TMP, 'main');
  const run = (script, args) => new Promise((res) => {
    let out = '';
    const c = spawn(process.execPath, [path.join(ROOT, 'src', 'cli', script), 'test', ...args], { cwd: main });
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => res({ code, out }));
  });
  const before = sh('git rev-parse main', path.join(TMP, 'origin.git'));
  const rel = await run('release.js', ['--patch', '--branch=none']);
  check(rel.code !== 0 && /release train/.test(rel.out), 'npm run release wird abgewiesen');
  const dep = await run('deploy.js', []);
  check(dep.code !== 0 && /release train/.test(dep.out), 'npm run deploy wird abgewiesen');
  check(sh('git rev-parse main', path.join(TMP, 'origin.git')) === before, 'main unverändert');
}

async function main() {
  const t0 = Date.now();
  try {
    await setup();
    // ONLY=1,5 runs a subset (scenario 1 always runs first: it sets up the release clone)
    const only = (process.env.ONLY || '').split(',').filter(Boolean);
    const want = (n) => !only.length || only.includes(String(n));
    await scenarioParallel();
    if (want(2)) await scenarioKilledDriver();
    if (want(3)) await scenarioBrokenBuild();
    if (want(4)) await scenarioConflict();
    if (want(5)) await scenarioBootstrapChange();
    if (want(6)) await scenarioLegacyRefused();
  } finally {
    if (process.env.KEEP !== '1') {
      await remote(`rm -rf ${REMOTE}`).catch(() => {});
      try { sh('git worktree prune', path.join(TMP, 'main')); } catch { /* ignore */ }
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  console.log(`\n${failures ? `❌ ${failures} Prüfung(en) fehlgeschlagen` : '✅ alle Prüfungen grün'} (${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
