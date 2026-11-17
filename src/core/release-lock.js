// src/core/release-lock.js — one release per project and target at a time, across machines (v0.6.0).
//
// Several agents release the same project from different machines (notebook, NUC). A local lock file cannot see
// the others, the server can: the lock is a directory next to the deploy target, created with an atomic `mkdir`
// (`<remoteBasePath>.release-lock-<target>`), holding owner.json (host, user, pid, version, time). Whoever finds it
// waits and retries; a lock older than RELEASE_LOCK_STALE_MIN (default 30) is presumed dead and broken.
import os from 'os';
import { connectFromEnv } from './ssh.js';

const POLL_MS = 10_000;

const q = (s) => `'${String(s).replace(/'/g, `'\''`)}'`;

export async function acquireReleaseLock({ ENV_FILE, REMOTE_BASE_PATH, target, log = console.log }) {
  const staleMin = Number(process.env.RELEASE_LOCK_STALE_MIN || 30);
  const maxWaitMin = Number(process.env.RELEASE_LOCK_MAX_WAIT_MIN || 60);
  const dir = `${REMOTE_BASE_PATH.replace(/\/+$/, '')}/.release-lock-${target}`;
  const owner = { host: os.hostname(), user: os.userInfo().username, pid: process.pid, cwd: process.cwd(),
                  startedAt: new Date().toISOString() };
  const ssh = await connectFromEnv(ENV_FILE);
  const start = Date.now();
  try {
    for (;;) {
      const r = await ssh.execCommand(
        `mkdir ${q(dir)} 2>/dev/null && printf %s ${q(JSON.stringify(owner))} > ${q(dir + '/owner.json')} && echo LOCKED || ` +
        `{ echo HELD; cat ${q(dir + '/owner.json')} 2>/dev/null; echo; echo AGE $(( $(date +%s) - $(stat -c %Y ${q(dir)} 2>/dev/null || date +%s) )); }`);
      if (r.stdout.startsWith('LOCKED')) {
        log(`🔒 Release lock ${dir} acquired.`);
        return {
          async release() {
            try {
              await ssh.execCommand(`grep -q ${q(`"pid":${owner.pid},`)} ${q(dir + '/owner.json')} && rm -rf ${q(dir)}`);
              log('🔓 Release lock released.');
            } finally { ssh.dispose(); }
          },
        };
      }
      const age = Number((r.stdout.match(/AGE (\d+)/) || [])[1] || 0);
      const held = (r.stdout.split('\n')[1] || '').trim() || 'unknown owner';
      if (age > staleMin * 60) {
        log(`🧹 Breaking stale release lock (${Math.round(age / 60)} min old): ${held}`);
        await ssh.execCommand(`rm -rf ${q(dir)}`);
        continue;
      }
      if (Date.now() - start > maxWaitMin * 60_000) {
        throw new Error(`Timed out after ${maxWaitMin} min waiting for the release lock, held by ${held}`);
      }
      log(`⏳ Another release is running (${held}, ${age}s) — waiting…`);
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
