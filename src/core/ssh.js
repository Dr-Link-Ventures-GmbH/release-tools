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
    // v0.8.5: keep idle connections alive (long builds, blackout waits) so they do not drop with ECONNRESET
    keepaliveInterval: 15000,
    keepaliveCountMax: 8,
  };
  if (!cfg.host || !cfg.username || !cfg.privateKeyPath) {
    throw new Error(`Missing SSH env vars. Need SSH_HOST, SSH_USER, SSH_KEY (and optional SSH_PASSPHRASE). Expected in: ${envFile}`);
  }
  const ssh = new NodeSSH();
  await ssh.connect(cfg);
  // swallow late socket errors (ECONNRESET on a dropped idle connection) so they never crash the process as an
  // uncaught 'error' event; a pending command still rejects and the caller's retry/poll loop handles it
  try { ssh.connection?.on('error', () => {}); } catch { /* ignore */ }
  // v0.8.1: alpha sporadically refuses a channel when many releases run at once ("Channel open failure",
  // 23.11.2026: 13 parallel releases, and in the e2e test). A command never started on the server, so it is
  // safe to retry — with backoff, on the same connection.
  for (const fn of ['execCommand', 'putFile']) {
    const orig = ssh[fn].bind(ssh);
    ssh[fn] = async (...a) => {
      for (let i = 1; ; i++) {
        try { return await orig(...a); }
        catch (e) {
          if (i >= 6 || !/Channel open failure|open failed/i.test(String(e?.message))) throw e;
          await new Promise((r) => setTimeout(r, 500 * i * i));
        }
      }
    };
  }
  return ssh;
}
