/**
 * GitHub-backed SQLite persistence for Hivemind.
 *
 * Use case: Render free tier has NO persistent disk. SQLite file gets wiped on every
 * restart. This module periodically backs up the SQLite file to a private GitHub repo
 * and restores it on boot.
 *
 * Setup:
 *   GITHUB_TOKEN          — personal access token with 'repo' scope
 *   GITHUB_BACKUP_REPO    — "username/repo-name" (will be created if doesn't exist)
 *   GITHUB_BACKUP_BRANCH  — branch name (default: main)
 *   BACKUP_INTERVAL_SEC   — how often to push backup (default: 300 = 5min)
 *
 * On boot: tries to download latest backup from GitHub before starting server.
 * On shutdown (SIGTERM): pushes one final backup.
 * Periodically: pushes incremental backups.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_BACKUP_REPO;
const BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'main';
const INTERVAL = parseInt(process.env.BACKUP_INTERVAL_SEC || '300', 10) * 1000;

const enabled = !!(TOKEN && REPO);
const DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'hivemind.db');
const BACKUP_PATH = 'data/hivemind.db.gz';

function gh(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent': 'hivemind-backup',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed;
        try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf.toString(); }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`GitHub ${method} ${urlPath} → ${res.statusCode}: ${typeof parsed === 'string' ? parsed.slice(0, 200) : (parsed.message || JSON.stringify(parsed).slice(0, 200))}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureRepoExists() {
  try {
    await gh('GET', `/repos/${REPO}`);
    return true;
  } catch (e) {
    if (!e.message.includes('404')) throw e;
    // Create repo
    const [owner, name] = REPO.split('/');
    console.log(`📦 Creating backup repo: ${REPO}`);
    await gh('POST', '/user/repos', {
      name,
      private: true,
      description: 'Hivemind database backups (auto-managed, do not edit)',
      auto_init: true,
    }).catch(async () => {
      // Maybe already exists in org
      await gh('POST', `/orgs/${owner}/repos`, {
        name,
        private: true,
        description: 'Hivemind database backups',
        auto_init: true,
      });
    });
    // Wait a sec for init
    await new Promise(r => setTimeout(r, 2000));
    return true;
  }
}

async function downloadBackup() {
  if (!enabled) return false;
  try {
    const file = await gh('GET', `/repos/${REPO}/contents/${BACKUP_PATH}?ref=${BRANCH}`);
    if (!file || !file.content) return false;
    const compressed = Buffer.from(file.content, 'base64');
    const decompressed = zlib.gunzipSync(compressed);
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, decompressed);
    console.log(`✓ Restored DB from GitHub backup (${(decompressed.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (e) {
    if (e.message.includes('404')) {
      console.log('ℹ No prior backup found — starting fresh');
      return false;
    }
    console.error('⚠ Backup restore failed:', e.message);
    return false;
  }
}

let lastSha = null;
let backing_up = false;
let lastHash = null;

async function uploadBackup(forceFinal = false) {
  if (!enabled) return false;
  if (backing_up) return false;
  if (!fs.existsSync(DB_PATH)) return false;
  backing_up = true;
  try {
    const dbBuf = fs.readFileSync(DB_PATH);
    const compressed = zlib.gzipSync(dbBuf, { level: 9 });
    // Hash to skip if unchanged
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(compressed).digest('hex');
    if (!forceFinal && hash === lastHash) {
      backing_up = false;
      return false; // No changes
    }

    // Get current SHA if file exists
    if (lastSha === null) {
      try {
        const existing = await gh('GET', `/repos/${REPO}/contents/${BACKUP_PATH}?ref=${BRANCH}`);
        lastSha = existing.sha;
      } catch { lastSha = undefined; }
    }

    const body = {
      message: `Backup ${new Date().toISOString()} (${(dbBuf.length / 1024).toFixed(1)} KB)`,
      content: compressed.toString('base64'),
      branch: BRANCH,
    };
    if (lastSha) body.sha = lastSha;

    const result = await gh('PUT', `/repos/${REPO}/contents/${BACKUP_PATH}`, body);
    lastSha = result.content.sha;
    lastHash = hash;
    console.log(`✓ Backed up DB to GitHub (${(compressed.length / 1024).toFixed(1)} KB gzipped)`);
    return true;
  } catch (e) {
    console.error('⚠ Backup upload failed:', e.message);
    // Reset SHA so next attempt re-fetches it
    lastSha = null;
    return false;
  } finally {
    backing_up = false;
  }
}

function startPeriodicBackup() {
  if (!enabled) return;
  console.log(`💾 GitHub backup enabled: ${REPO} (every ${INTERVAL / 1000}s)`);
  setInterval(() => { uploadBackup().catch(() => {}); }, INTERVAL);
  // Final backup on shutdown
  const onExit = async () => {
    console.log('🛑 Shutdown: flushing final backup...');
    try { await uploadBackup(true); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
}

module.exports = {
  enabled,
  async init() {
    if (!enabled) {
      console.log('ℹ GitHub backup disabled (set GITHUB_TOKEN + GITHUB_BACKUP_REPO to enable)');
      return;
    }
    try {
      await ensureRepoExists();
      await downloadBackup();
    } catch (e) {
      console.error('⚠ Backup init failed:', e.message);
    }
  },
  startPeriodicBackup,
  uploadBackup,
  downloadBackup,
};
