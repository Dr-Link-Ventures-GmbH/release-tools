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
        log(`📁 Ensuring remote dir exists: ${remoteTargetDir}`);
        const mkdirRes = await ssh.execCommand(`mkdir -p "${remoteTargetDir}"`);
        if (mkdirRes.stderr) console.error('❗ MKDIR STDERR:', mkdirRes.stderr);

        log('🧪 Permission check (touch .deploy-test)...');
        const testFile = `${remoteTargetDir}/.deploy-test`;
        const permRes = await ssh.execCommand(
          `echo "ok" > "${testFile}" && rm -f "${testFile}" && echo "write-ok"`
        );
        if (!permRes.stdout.includes('write-ok')) {
          console.error('❌ No write permission in remote target directory.');
          if (permRes.stderr) console.error('   STDERR:', permRes.stderr);
          process.exit(1);
        }

        // Selective clean: when `preserveSubdirs` is set, wipe everything
        // INSIDE the target except the named subdirs (e.g. uploads/). Without
        // that list we keep the legacy `rm -rf ${remoteTargetDir}` behaviour.
        // Why this matters: when the SSH user is not in the www-data group,
        // rm -rf on a mixed-ownership tree fails silently on some subdirs
        // (perm-denied is swallowed by rm) and succeeds on others — meaning
        // runtime data living inside the target can get partially shredded.
        // Hardcoded reference incident: NAKBase 2026-05-29 lost 89 image
        // files because articles/ + misc/ were temruk-owned and got wiped
        // while persons/ + divineservices/ (www-data-owned) survived.
        const preserve = item.preserveSubdirs ?? [];
        let cleanCmd;
        if (preserve.length > 0) {
          const notNames = preserve.map(s => `! -name ${JSON.stringify(s)}`).join(' ');
          cleanCmd =
            `mkdir -p "${remoteTargetDir}" && ` +
            `find "${remoteTargetDir}" -mindepth 1 -maxdepth 1 ${notNames} -exec rm -rf {} +`;
          log(`🧹 Cleaning remote dir (preserving: ${preserve.join(', ')}): ${remoteTargetDir}`);
        } else {
          cleanCmd = `rm -rf "${remoteTargetDir}" && mkdir -p "${remoteTargetDir}"`;
          log(`🧹 Cleaning remote dir: ${remoteTargetDir}`);
        }
        const cleanRes = await ssh.execCommand(cleanCmd);
        if (cleanRes.stderr) console.error('❗ CLEAN STDERR:', cleanRes.stderr);

        log(`📤 Uploading folder ${item.path} → ${remoteTargetDir} ...`);
        const ok = await ssh.putDirectory(item.path, remoteTargetDir, {
          recursive: true,
          concurrency: 5,
          validate: () => true,
          tick: (localPath, remotePath, error) => {
            if (error) console.error('❌ Upload error:', { localPath, remotePath, message: error.message });
          },
        });

        if (!ok) {
          console.error('❌ Upload failed (putDirectory returned false).');
          process.exit(1);
        }

        // Apache (www-data) needs read on files, traverse (x) on dirs
        await ssh.execCommand(`chmod -R o+rX "${remoteTargetDir}"`);
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
