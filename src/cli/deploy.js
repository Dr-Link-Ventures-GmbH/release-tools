// src/cli/deploy.js
//
// Uploads each item from bootstrap DEPLOY_ITEMS via SSH (node-ssh).
// Adopted from NAKPortal: pre-upload permission check, clean target
// directory, chmod o+rX after upload so Apache (www-data) can read.
//
// Can be invoked as a CLI (`node deploy.js <target>`) or imported as
// `runDeploy(bootstrap)` from release.js.

import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { connectFromEnv } from '../core/ssh.js';
import { compareVersions } from '../core/release-lock.js';
import { pathToFileURL } from 'url';
import loadProjectBootstrap from '../core/load-project-bootstrap.js';

export async function runDeploy(bootstrap) {
  const {
    REMOTE_BASE_PATH,
    ENV_FILE,
    target,
    DEPLOY_ITEMS,
    RUN_COMPOSER = false,
    POST_DEPLOY_COMMANDS = [],
    flags = {},
  } = bootstrap;

  const log = (...args) => { if (!flags.silent) console.log(...args); };

  if (!target) throw new Error('No target specified');

  const remoteBase = `${REMOTE_BASE_PATH}${target}`;

  log(`🔐 Connecting to server (${target})...`);
  const ssh = await connectFromEnv(ENV_FILE);

  // v0.6.0: never overwrite a newer version. Another agent may have released (or deployed by hand) in the meantime;
  // its build.info / version.json on the server then carries a higher version than ours. RELEASE_FORCE=1 overrides.
  // read fresh: release.js bumps package.json after the bootstrap was loaded
  let localVersion = bootstrap.packageJson?.version;
  try { localVersion = JSON.parse(fs.readFileSync(bootstrap.PACKAGE_JSON_FILE, 'utf8')).version || localVersion; } catch { /* keep */ }
  if (localVersion && process.env.RELEASE_FORCE !== '1') {
    for (const item of DEPLOY_ITEMS.filter(i => i.isDir)) {
      const dir = item.remoteSubdir ? `${remoteBase}/${item.remoteSubdir}` : remoteBase;
      const r = await ssh.execCommand(`cat "${dir}/build.info" 2>/dev/null || cat "${dir}/version.json" 2>/dev/null`);
      let remoteVersion = null;
      try { remoteVersion = JSON.parse(r.stdout).version; } catch { /* nothing deployed yet or no version file */ }
      if (remoteVersion && compareVersions(remoteVersion, localVersion) > 0) {
        ssh.dispose();
        throw new Error(`Server already runs ${remoteVersion} in ${dir}, newer than this release ${localVersion} — ` +
          'someone else released in the meantime. Pull, rebase and release again (RELEASE_FORCE=1 overrides).');
      }
      if (remoteVersion) log(`🔎 Server ${dir}: ${remoteVersion} → ${localVersion}`);
    }
  }

  try {
    for (const item of DEPLOY_ITEMS) {
      if (!fs.existsSync(item.path)) {
        console.warn(`⚠️  Skipping: '${item.path}' does not exist.`);
        continue;
      }

      const remoteTargetDir = item.remoteSubdir ? `${remoteBase}/${item.remoteSubdir}` : remoteBase;
      const remoteTargetFile = `${remoteTargetDir}/${path.basename(item.path)}`;

      if (item.isDir) {
        // Tar-based deploy: pack locally, upload ONE archive, unpack into a
        // staging dir next to the target and swap directories. Hundreds of
        // per-file SFTP round trips collapse into a single upload, and the
        // swap (two mv calls) replaces the old rm-rf + slow re-upload window
        // during which Apache served a half-empty dir.
        const parent = path.posix.dirname(remoteTargetDir);
        const base = path.posix.basename(remoteTargetDir);
        const staging = `${remoteTargetDir}.staging`;
        const trash = `${remoteTargetDir}.old-${Date.now()}`;
        const remoteTar = `${parent}/.deploy-${base}.tgz`;

        log(`📦 Packing ${item.path} ...`);
        const localTar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-')), `${base}.tgz`);
        // On Windows, Git Bash's GNU tar parses "C:\..." as host:path
        // ("Cannot connect to C"). The bundled bsdtar handles drive letters.
        const tarBin = process.platform === 'win32'
          ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
          : 'tar';
        execSync(`"${tarBin}" -czf "${localTar}" -C "${item.path}" .`, { stdio: 'inherit' });

        log('🧪 Permission check (parent dir writable, remote tar present)...');
        const permRes = await ssh.execCommand(
          `mkdir -p "${parent}" && echo ok > "${parent}/.deploy-test" && rm -f "${parent}/.deploy-test" && command -v tar >/dev/null && echo "write-ok"`
        );
        if (!permRes.stdout.includes('write-ok')) {
          console.error('❌ Parent dir not writable or remote tar missing.');
          if (permRes.stderr) console.error('   STDERR:', permRes.stderr);
          throw new Error('Deploy step failed (see above).');
        }

        log(`📤 Uploading archive → ${remoteTar} ...`);
        await ssh.putFile(localTar, remoteTar);
        fs.rmSync(path.dirname(localTar), { recursive: true, force: true });

        log(`📂 Unpacking into staging: ${staging}`);
        const unpackRes = await ssh.execCommand(
          `rm -rf "${staging}" && mkdir -p "${staging}" && tar -xzf "${remoteTar}" -C "${staging}" && rm -f "${remoteTar}" && chmod -R o+rX "${staging}" && echo "unpack-ok"`
        );
        if (!unpackRes.stdout.includes('unpack-ok')) {
          console.error('❌ Remote unpack failed.');
          if (unpackRes.stderr) console.error('   STDERR:', unpackRes.stderr);
          throw new Error('Deploy step failed (see above).');
        }

        // Runtime data (preserveSubdirs, e.g. uploads/) moves from the live
        // dir into staging BEFORE the swap, so it survives every deploy —
        // same guarantee the old selective clean gave, without the
        // mixed-ownership rm -rf hazard (NAKBase 2026-05-29: 89 image files
        // lost because rm -rf silently skipped www-data-owned subdirs while
        // shredding temruk-owned ones).
        const preserve = item.preserveSubdirs ?? [];
        for (const sub of preserve) {
          const mvRes = await ssh.execCommand(
            `if [ -e "${remoteTargetDir}/${sub}" ]; then rm -rf "${staging}/${sub}" && mv "${remoteTargetDir}/${sub}" "${staging}/${sub}" && echo "kept"; else echo "absent"; fi`
          );
          log(`♻️  preserve ${sub}: ${mvRes.stdout.trim() || mvRes.stderr.trim()}`);
        }

        log(`🔁 Swapping ${staging} → ${remoteTargetDir}`);
        const swapRes = await ssh.execCommand(
          `{ [ ! -e "${remoteTargetDir}" ] || mv "${remoteTargetDir}" "${trash}"; } && mv "${staging}" "${remoteTargetDir}" && echo "swap-ok"`
        );
        if (!swapRes.stdout.includes('swap-ok')) {
          console.error('❌ Swap failed — the previous version may still be live.');
          if (swapRes.stderr) console.error('   STDERR:', swapRes.stderr);
          throw new Error('Deploy step failed (see above).');
        }

        // Best-effort cleanup: a mixed-ownership .old dir may resist rm -rf;
        // that's harmless, the new version is already live.
        const rmRes = await ssh.execCommand(`rm -rf "${trash}"`);
        if (rmRes.stderr) console.error('❗ OLD-DIR CLEANUP STDERR:', rmRes.stderr);
      } else {
        log(`📤 Uploading file ${item.path} → ${remoteTargetFile} ...`);
        await ssh.execCommand(`mkdir -p "${remoteTargetDir}"`);
        await ssh.putFile(item.path, remoteTargetFile);
        await ssh.execCommand(`chmod o+r "${remoteTargetFile}"`);
      }

      log(`✅ Uploaded ${item.path}`);
    }

    if (RUN_COMPOSER || process.env.DEPLOY_RUN_COMPOSER === '1') {
      log('📦 Running composer install remotely ...');
      const { stdout, stderr } = await ssh.execCommand(
        `cd ${remoteBase} && composer install --no-dev --optimize-autoloader`
      );
      if (stdout) log(stdout);
      if (stderr) console.error(stderr);
    }

    // Post-deploy commands (e.g. "sudo systemctl reload apache2" to flush the PHP opcache).
    // A command starting with "sudo " gets SSH_SUDO_PASSWORD (fallback SSH_PASSPHRASE) on stdin — never on the
    // command line, where it would show up in `ps` on the server (v0.5.4; before: echo "<pw>" | sudo -S …).
    // Every command must exit 0, otherwise the release stops here (a failed restart is not a release).
    for (const rawCmd of POST_DEPLOY_COMMANDS) {
      const cmd = String(rawCmd || '').trim();
      if (!cmd) continue;
      let execCmd = cmd;
      const opts = {};
      if (cmd.startsWith('sudo ')) {
        const pwd = process.env.SSH_SUDO_PASSWORD || process.env.SSH_PASSPHRASE || '';
        execCmd = `sudo -S -p '' ${cmd.slice(5)}`;
        opts.stdin = `${pwd}
`;
      }
      log(`🔧 Post-deploy: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(execCmd, opts);
      if (stdout) log(stdout.trim());
      if (stderr && !stderr.includes('password for')) console.error(stderr.trim());
      if (code !== 0 && code !== null) {
        throw new Error(`Post-deploy command failed (exit ${code}): ${cmd}`);
      }
    }
  } finally {
    ssh.dispose();
  }

  log(`🚀 Deployment to ${target} completed.`);
}

// Run as CLI when invoked directly (not when imported)
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    const bootstrap = await loadProjectBootstrap();
    await runDeploy(bootstrap);
    process.exit(0);
  } catch (err) {
    console.error('❌ Deployment failed:', err?.message ?? err);
    process.exit(1);
  }
}
