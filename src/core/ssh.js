// src/core/ssh.js — one SSH connection from the project's env (SSH_HOST/USER/KEY/PASSPHRASE).
import dotenv from 'dotenv';
import { NodeSSH } from 'node-ssh';

export async function connectFromEnv(envFile) {
  dotenv.config({ path: envFile });
  const cfg = {
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    privateKeyPath: process.env.SSH_KEY,
    passphrase: process.env.SSH_PASSPHRASE,
    readyTimeout: 30000,
  };
  if (!cfg.host || !cfg.username || !cfg.privateKeyPath) {
    throw new Error(`Missing SSH env vars. Need SSH_HOST, SSH_USER, SSH_KEY (and optional SSH_PASSPHRASE). Expected in: ${envFile}`);
  }
  const ssh = new NodeSSH();
  await ssh.connect(cfg);
  return ssh;
}
