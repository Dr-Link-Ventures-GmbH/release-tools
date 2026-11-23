// src/core/release-lock.js — one release per project and target at a time, across machines (v0.6.0, heartbeat v0.7.0).
//
// Several agents release the same project from different machines (notebook, NUC). A local lock file cannot see
// the others, the server can: the lock is a directory next to the deploy target, created with an atomic `mkdir`
// (`<remoteBasePath>/.release-lock-<target>`), holding owner.json (host, user, pid, time). Whoever finds it waits
// and retries.
//
// Staleness: since v0.7.0 the holder touches the lock dir every 20 s (heartbeat, marked in owner.json). Such a lock
// is dead once it has not been touched for RELEASE_LOCK_HEARTBEAT_STALE_MIN (default 3) — a killed agent (tool
// timeout, Ctrl+C) no longer blocks the project for half an hour, and a long build is never mistaken for a dead one.
// Locks of older tool versions (no heartbeat) keep the old rule: dead after RELEASE_LOCK_STALE_MIN (default 30).
import os from 'os';
import { connectFromEnv } from './ssh.js';

const POLL_MS = 10_000;
const HEARTBEAT_MS = 20_000;

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function lockDir(REMOTE_BASE_PATH, target) {
  return `${REMOTE_BASE_PATH.replace(/\/+$/, '')}/.release-lock-${target}`;
}

/**
 * One attempt. Resolves to { lock } when acquired, or { held, age } when someone else holds it.
 * A dead lock is broken and retried within the same call. `ssh` stays owned by the caller until a lock is
 * returned; the lock then owns it (lock.release() disposes it).
 */
export async function tryAcquireReleaseLock(ssh, { REMOTE_BASE_PATH, target, log = console.log }) {
  const staleMin = Number(process.env.RELEASE_LOCK_STALE_MIN || 30);
  const hbStaleMin = Number(process.env.RELEASE_LOCK_HEARTBEAT_STALE_MIN || 3);
  const dir = lockDir(REMOTE_BASE_PATH, target);
  const owner = { host: os.hostname(), user: os.userInfo().username, pid: process.pid, cwd: process.cwd(),
                  startedAt: new Date().toISOString(), heartbeat: true };
  for (let i = 0; i < 3; i++) {
    const r = await ssh.execCommand(
      `mkdir ${q(dir)} 2>/dev/null && printf %s ${q(JSON.stringify(owner))} > ${q(dir + '/owner.json')} && echo LOCKED || ` +
      `{ echo HELD; cat ${q(dir + '/owner.json')} 2>/dev/null; echo; echo AGE $(( $(date +%s) - $(stat -c %Y ${q(dir)} 2>/dev/null || date +%s) )); }`);
    if (r.stdout.startsWith('LOCKED')) {
      const timer = setInterval(() => { ssh.execCommand(`touch ${q(dir)}`).catch(() => {}); }, HEARTBEAT_MS);
      timer.unref?.();
      log(`🔒 Release lock ${dir} acquired.`);
      return {
        lock: {
          dir,
          async release() {
            clearInterval(timer);
            try {
              await ssh.execCommand(`grep -q ${q(`"pid":${owner.pid},`)} ${q(dir + '/owner.json')} && rm -rf ${q(dir)}`);
              log('🔓 Release lock released.');
            } finally { ssh.dispose(); }
          },
        },
      };
    }
    const age = Number((r.stdout.match(/AGE (\d+)/) || [])[1] || 0);
    const held = (r.stdout.split('\n')[1] || '').trim() || 'unknown owner';
    let heartbeat = false;
    try { heartbeat = !!JSON.parse(held).heartbeat; } catch { /* older owner.json or none */ }
    const limit = (heartbeat ? hbStaleMin : staleMin) * 60;
    if (age > limit) {
      log(`🧹 Breaking dead release lock (${age}s without ${heartbeat ? 'heartbeat' : 'change'}): ${held}`);
      await ssh.execCommand(`rm -rf ${q(dir)}`);
      continue;
    }
    return { held, age };
  }
  return { held: 'lock flapping', age: 0 };
}

/** Blocking acquire (used by release.js): waits up to RELEASE_LOCK_MAX_WAIT_MIN (default 60). */
export async function acquireReleaseLock({ ENV_FILE, REMOTE_BASE_PATH, target, log = console.log }) {
  const maxWaitMin = Number(process.env.RELEASE_LOCK_MAX_WAIT_MIN || 60);
  const ssh = await connectFromEnv(ENV_FILE);
  const start = Date.now();
  try {
    for (;;) {
      const r = await tryAcquireReleaseLock(ssh, { REMOTE_BASE_PATH, target, log });
      if (r.lock) return r.lock;
      if (Date.now() - start > maxWaitMin * 60_000) {
        throw new Error(`Timed out after ${maxWaitMin} min waiting for the release lock, held by ${r.held}`);
      }
      log(`⏳ Another release is running (${r.held}, ${r.age}s) — waiting…`);
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
  } catch (e) {
    ssh.dispose();
    throw e;
  }
}

/** CalVer/semver compare: 1 if a > b, -1 if a < b, 0 if equal or not comparable. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10));
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * v0.8.0: a project that releases with the train (its server carries <base>/.release-state-<target>.json) must not
 * be released or deployed the old way any more — that path writes version commits onto main and deploys whatever
 * the local checkout holds, past the train. RELEASE_LEGACY=1 overrides (emergencies only).
 */
export async function assertNotTrainProject(ssh, REMOTE_BASE_PATH, target) {
  if (process.env.RELEASE_LEGACY === '1') return;
  const state = `${REMOTE_BASE_PATH.replace(/\/+$/, '')}/.release-state-${target}.json`;
  const r = await ssh.execCommand(`test -f ${q(state)} && echo TRAIN`);
  if (r.stdout.trim() === 'TRAIN') {
    throw new Error(`This project releases with the release train (${state} exists). ` +
      `Use: npm run release:train -- ${target} --push   (NAKPortal/NAKBase: npm run release:prod -- <branch>). ` +
      'RELEASE_LEGACY=1 overrides — emergencies only.');
  }
}
