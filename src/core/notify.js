// src/core/notify.js — release-train messages to Slack #releases (v0.8.4).
//
// Sent by the Slack app "Release-Zug" (DLV workspace): broken build/deploy of main, rollback, main green again.
// Configuration per machine, never in a repo:
//   RELEASE_SLACK_TOKEN + RELEASE_SLACK_CHANNEL   (env), or
//   ~/.release-tools/slack.json                    { "token": "xoxb-…", "channel": "C…" }
// Nothing configured, or RELEASE_NOTIFY=0 → silent. A failing message never fails a release.
import fs from 'fs';
import os from 'os';
import path from 'path';

function config() {
  if (process.env.RELEASE_NOTIFY === '0') return null;
  if (process.env.RELEASE_SLACK_TOKEN && process.env.RELEASE_SLACK_CHANNEL) {
    return { token: process.env.RELEASE_SLACK_TOKEN, channel: process.env.RELEASE_SLACK_CHANNEL };
  }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.release-tools', 'slack.json'), 'utf8'));
    return c.token && c.channel ? c : null;
  } catch { return null; }
}

export async function notify(text) {
  const c = config();
  if (!c) return false;
  try {
    const api = process.env.RELEASE_SLACK_API || 'https://slack.com/api';   // test: a local mock
    const r = await fetch(`${api}/chat.postMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: c.channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    if (!j.ok) console.error(`⚠️  Slack notify failed: ${j.error}`);
    return !!j.ok;
  } catch (e) {
    console.error(`⚠️  Slack notify failed: ${e.message}`);
    return false;
  }
}
