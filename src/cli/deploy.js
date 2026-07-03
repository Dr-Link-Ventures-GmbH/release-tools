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
import dotenv from 'dotenv';
import { NodeSSH } from 'node-ssh';
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

  if (!target) {
    console.error('❌ No target specified');
    process.exit(1);
  }

  dotenv.config({ path: ENV_FILE });

  const sshConfig = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    privateKeyPath: process.env.SSH_KEY,
    passphrase: process.env.SSH_PASSPHRASE,
  };

  if (!sshConfig.host || !sshConfig.username || !sshConfig.privateKeyPath) {
    console.error('❌ Missing SSH env vars. Need SSH_HOST, SSH_USER, SSH_KEY (and optional SSH_PASSPHRASE).');
    console.error(`   Expected in: ${ENV_FILE}`);
    process.exit(1);
  }

  const remoteBase = `${REMOTE_BASE_PATH}${target}`;

  log(`🔐 Connecting to server (${target})...`);
  const ssh = new NodeSSH();
  await ssh.connect(sshConfig);

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
        execSync(`tar -czf "${localTar}" -C "${item.path}" .`, { stdio: 'inherit' });

        log('🧪 Permission check (parent dir writable, remote tar present)...');
        const permRes = await ssh.execCommand(
          `mkdir -p "${parent}" && echo ok > "${parent}/.deploy-test" && rm -f "${parent}/.deploy-test" && command -v tar >/dev/null && echo "write-ok"`
        );
        if (!permRes.stdout.includes('write-ok')) {
          console.error('❌ Parent dir not writable or remote tar missing.');
          if (permRes.stderr) console.error('   STDERR:', permRes.stderr);
          process.exit(1);
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
          process.exit(1);
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
          process.exit(1);
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

    // Post-deploy commands (z.B. "sudo systemctl reload apache2" für PHP-Opcache-Flush).
    // Commands die mit "sudo " beginnen werden automatisch via SSH_SUDO_PASSWORD/SSH_PASSPHRASE gepiped.
    for (const rawCmd of POST_DEPLOY_COMMANDS) {
      const cmd = String(rawCmd || '').trim();
      if (!cmd) continue;
      let execCmd = cmd;
      if (cmd.startsWith('sudo ')) {
        const pwd = process.env.SSH_SUDO_PASSWORD || process.env.SSH_PASSPHRASE || '';
        execCmd = `echo "${pwd}" | sudo -S ${cmd.slice(5)}`;
      }
      log(`🔧 Post-deploy: ${cmd}`);
      const { stdout, stderr } = await ssh.execCommand(execCmd);
      if (stdout) log(stdout.trim());
      if (stderr && !stderr.includes('password for')) console.error(stderr.trim());
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
