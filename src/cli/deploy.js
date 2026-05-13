// src/cli/deploy.js

console.log('🟡 DEBUG: deploy.js started');

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { NodeSSH } from 'node-ssh';
import loadProjectBootstrap from '../core/load-project-bootstrap.js';

(async () => {
  try {
    console.log('🟡 DEBUG: argv =', process.argv);

    const bootstrapPromise = await loadProjectBootstrap();

    const {
      REMOTE_BASE_PATH,
      ENV_FILE,
      target,
      DEPLOY_ITEMS,
    } = await bootstrapPromise;

    console.log('🟡 DEBUG: target =', target);

    dotenv.config({ path: ENV_FILE });

    if (!target) {
      console.error('❌ No target specified');
      process.exit(1);
    }

    console.log('🟡 DEBUG: bootstrap loaded:', { REMOTE_BASE_PATH });

    const ssh = new NodeSSH();
    console.log('🟡 DEBUG: SSH module loaded');

    const config = {
      host: process.env.SSH_HOST,
      username: process.env.SSH_USER,
      privateKeyPath: process.env.SSH_KEY,
      passphrase: process.env.SSH_PASSPHRASE,
    };

    const remoteBase = `${REMOTE_BASE_PATH}${target}`;

    console.log(`🔐 Connecting to server (${target})...`);
    await ssh.connect(config);

    for (const item of DEPLOY_ITEMS) {
      const remoteTargetDir = item.remoteSubdir ? `${remoteBase}/${item.remoteSubdir}` : remoteBase;
      const remoteTargetFile = `${remoteTargetDir}/${path.basename(item.path)}`;

      if (!fs.existsSync(item.path)) {
        console.warn(`⚠️  Skipping: '${item.path}' does not exist.`);
        continue;
      }

      if (item.isDir) {
        console.log(`📤 Uploading folder ${item.path} to ${remoteTargetDir} ...`);
        await ssh.putDirectory(item.path, remoteTargetDir, {
          recursive: true,
          concurrency: 5,
          validate: () => true,
        });
      } else {
        console.log(`📤 Uploading file ${item.path} to ${remoteTargetFile} ...`);
        await ssh.putFile(item.path, remoteTargetFile);
      }

      console.log(`✅ Uploaded ${item.path}`);
    }

    // Run comoposer remotely, if required through ENV
    if (process.env.DEPLOY_RUN_COMPOSER === '1') {
      console.log('📦 Running composer install remotely ...');
      const { stdout, stderr } = await ssh.execCommand(
        `cd ${remoteBase} && composer install --no-dev --optimize-autoloader`
      );
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    }

    ssh.dispose();
    console.log(`🚀 Deployment to ${target} completed.`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Deployment failed:', err);
    process.exit(1);
  }
})();
