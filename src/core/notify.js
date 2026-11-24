// src/core/notify.js — release-train messages to a per-company Slack #releases (v0.8.5).
//
// Sent by the nuc bot of the project's workspace: broken build/deploy of main, rollback, main green again.
// Configuration per machine, never in a repo — ~/.release-tools/slack.json in one of two shapes:
//
//   single workspace (old):   { "token": "xoxb-…", "channel": "C…" }
//   per company (routing):    { "default": "dlv",
//                               "routes": { "<repo>": "<wsKey>", … },        // repo = origin basename, no .git
//                               "workspaces": { "dlv": { "token": "xoxb-…", "channel": "C…" }, … } }
//
// The workspace is chosen from the git repo (origin basename) of the current working directory (the release clone):
// routes[repo] → workspace, else default. RELEASE_SLACK_TOKEN + RELEASE_SLACK_CHANNEL (env) override everything
// (used by the e2e test). Nothing configured, or RELEASE_NOTIFY=0 → silent. A failing message never fails a release.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

function repoName() {
  try {
    const url = execSync('git config --get remote.origin.url', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return path.basename(url).replace(/\.git$/, '') || null;
  } catch { return null; }
}

/** Resolve { token, channel } for this release, or null when nothing is configured. */
function target() {
  if (process.env.RELEASE_NOTIFY === '0') return null;
  if (process.env.RELEASE_SLACK_TOKEN && process.env.RELEASE_SLACK_CHANNEL) {
    return { token: process.env.RELEASE_SLACK_TOKEN, channel: process.env.RELEASE_SLACK_CHANNEL, ws: 'env' };
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.release-tools', 'slack.json'), 'utf8')); } catch { return null; }
  if (cfg.token && cfg.channel && !cfg.workspaces) return { token: cfg.token, channel: cfg.channel, ws: 'single' };
  if (!cfg.workspaces) return null;
  const repo = repoName();
  const wsKey = (repo && cfg.routes && cfg.routes[repo]) || cfg.default;
  const ws = wsKey && cfg.workspaces[wsKey];
  if (!ws || !ws.token || !ws.channel) {
    console.error(`⚠️  Slack notify: no workspace for repo "${repo}" (wsKey ${wsKey || '—'})`);
    return null;
  }
  return { token: ws.token, channel: ws.channel, ws: wsKey };
}

export async function notify(text) {
  const t = target();
  if (!t) return false;
  try {
    const api = process.env.RELEASE_SLACK_API || 'https://slack.com/api';   // test: a local mock
    const r = await fetch(`${api}/chat.postMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: t.channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    if (!j.ok) console.error(`⚠️  Slack notify failed (${t.ws}): ${j.error}`);
    return !!j.ok;
  } catch (e) {
    console.error(`⚠️  Slack notify failed: ${e.message}`);
    return false;
  }
}
