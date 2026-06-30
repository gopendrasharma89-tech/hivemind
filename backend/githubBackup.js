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

// Mutable runtime config (can be reconfigured via admin endpoint)
let TOKEN = process.env.GITHUB_TOKEN || null;
let REPO = process.env.GITHUB_BACKUP_REPO || null;
let BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'main';
let INTERVAL = parseInt(process.env.BACKUP_INTERVAL_SEC || '300', 10) * 1000;
let intervalHandle = null;

function isEnabled() { return !!(TOKEN && REPO); }
const enabled = isEnabled();
const DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'hivemind.db');
const BACKUP_PATH = 'data/hivemind.db.gz';
const CONFIG_PATH = 'data/config.json';  // small JSON with current working token+repo, encrypted with JWT_SECRET

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

// SQLite file always starts with this 16-byte header ("SQLite format 3\0")
const SQLITE_MAGIC = Buffer.from('53514c69746520666f726d6174203300', 'hex');
function looksLikeSqlite(buf) { return buf && buf.length >= 100 && buf.slice(0, 16).equals(SQLITE_MAGIC); }

async function downloadBackup() {
  if (!isEnabled()) return false;
  // Try HEAD backup first, then fall back to the latest timestamped snapshot if HEAD is corrupt/missing.
  const candidates = [BACKUP_PATH];
  // Also try most recent snapshots
  try {
    const list = await gh('GET', `/repos/${REPO}/contents/data/snapshots?ref=${BRANCH}`);
    if (Array.isArray(list)) {
      list.sort((a, b) => (a.name < b.name ? 1 : -1));
      for (const f of list.slice(0, 5)) candidates.push(`data/snapshots/${f.name}`);
    }
  } catch { /* no snapshots dir yet */ }

  for (const candidate of candidates) {
    try {
      const file = await gh('GET', `/repos/${REPO}/contents/${candidate}?ref=${BRANCH}`);
      if (!file || !file.content) continue;
      const compressed = Buffer.from(file.content, 'base64');
      let decompressed;
      try { decompressed = zlib.gunzipSync(compressed); }
      catch (e) { console.warn(`⚠ ${candidate} unreadable (gzip): ${e.message}, trying next...`); continue; }
      if (!looksLikeSqlite(decompressed)) {
        console.warn(`⚠ ${candidate} not a valid SQLite file, trying next...`);
        continue;
      }
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, decompressed);
      console.log(`✓ Restored DB from ${candidate} (${(decompressed.length / 1024).toFixed(1)} KB)`);
      return true;
    } catch (e) {
      if (!e.message.includes('404')) console.error(`⚠ Restore from ${candidate} failed:`, e.message);
    }
  }
  console.log('ℹ No usable backup found — starting fresh');
  return false;
}

let lastSha = null;
let backing_up = false;
let lastHash = null;

// Force a WAL checkpoint so the .db file contains all latest writes before we snapshot it.
function checkpointDb() {
  try {
    const db = require('./db');
    // The 'TRUNCATE' mode blocks until WAL is fully merged into the main DB file.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    // db.js may not be loaded yet during early boot — that's fine, just skip.
  }
}

async function uploadBackup(forceFinal = false) {
  if (!isEnabled()) { console.log('upload: not enabled'); return false; }
  if (backing_up) { console.log('upload: already in flight'); return false; }
  if (!fs.existsSync(DB_PATH)) { console.log('upload: DB file missing at', DB_PATH); return false; }
  backing_up = true;
  try {
    checkpointDb();
    const dbBuf = fs.readFileSync(DB_PATH);
    const compressed = zlib.gzipSync(dbBuf, { level: 9 });
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(compressed).digest('hex');
    if (!forceFinal && hash === lastHash) {
      console.log('upload: hash unchanged, skipping');
      backing_up = false;
      return false;
    }
    console.log(`upload: pushing ${(dbBuf.length / 1024).toFixed(1)} KB DB to GitHub...`);

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
    try { require('./routes/admin').recordBackupHealth?.(true, null); } catch {}

    // Snapshot rotation — keep last ~24 timestamped snapshots so an old corrupt HEAD doesn't kill us.
    // Only snapshot on every ~Nth backup (sparse) to avoid hitting GitHub commit limits.
    if (forceFinal || Math.random() < 0.2) {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await gh('PUT', `/repos/${REPO}/contents/data/snapshots/hivemind-${ts}.db.gz`, {
          message: `Snapshot ${ts}`, content: compressed.toString('base64'), branch: BRANCH,
        });
        // Prune older snapshots (keep newest 24)
        try {
          const list = await gh('GET', `/repos/${REPO}/contents/data/snapshots?ref=${BRANCH}`);
          if (Array.isArray(list) && list.length > 24) {
            list.sort((a, b) => (a.name < b.name ? 1 : -1));
            for (const f of list.slice(24)) {
              await gh('DELETE', `/repos/${REPO}/contents/${f.path}`, { message: 'prune', sha: f.sha, branch: BRANCH }).catch(() => {});
            }
          }
        } catch {}
      } catch (e) { /* snapshot failure is non-fatal */ }
    }
    return true;
  } catch (e) {
    console.error('⚠ Backup upload failed:', e.message);
    lastSha = null;
    backing_up = false;
    // Record health for /admin/setup-status so wizard becomes visible on broken token
    try { require('./routes/admin').recordBackupHealth?.(false, e.message); } catch {}
    throw e;  // surface to caller so /admin/force-backup can return the error
  } finally {
    backing_up = false;
  }
}

function startPeriodicBackup() {
  if (!isEnabled()) return;
  if (intervalHandle) return; // already running
  console.log(`💾 GitHub backup enabled: ${REPO} (every ${INTERVAL / 1000}s)`);
  intervalHandle = setInterval(() => { uploadBackup().catch(() => {}); }, INTERVAL);
  // Synchronous final backup on shutdown — holds the process open until upload completes.
  // Render gives ~30s after SIGTERM before SIGKILL; we use it to flush every pending write.
  let shuttingDown = false;
  const onExit = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${sig}: flushing all pending backups before exit...`);
    try {
      await Promise.race([
        flushAll(true),
        new Promise(r => setTimeout(r, 25000)),
      ]);
      console.log('✓ Final backup flushed');
    } catch (e) { console.error('✗ Final backup error:', e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => onExit('SIGTERM'));
  process.on('SIGINT',  () => onExit('SIGINT'));
  process.on('uncaughtException', async (err) => {
    console.error('💥 Uncaught exception:', err);
    if (!shuttingDown) { shuttingDown = true; try { await flushAll(true); } catch {} }
    process.exit(1);
  });
}

// Aggressive write-tracked backup scheduler.
// Strategy: every successful write marks DB as dirty. A short fast-flush timer
// (default 2s) fires the next backup ASAP. If a backup is already in flight,
// the dirty flag persists so the *next* one will also run — guaranteeing the
// most recent write reaches GitHub even during rapid commit + redeploy.
let dirty = false;
let fastTimer = null;
let inFlight = false;
let pendingPromise = null;
const FAST_DELAY = 2000;

function triggerBackupSoon(delayMs = FAST_DELAY) {
  if (!isEnabled()) return;
  dirty = true;
  if (fastTimer) return;
  fastTimer = setTimeout(async () => {
    fastTimer = null;
    while (dirty) {
      dirty = false;
      try { pendingPromise = uploadBackup(); await pendingPromise; }
      catch {}
      pendingPromise = null;
    }
  }, delayMs);
}

// Returns a promise resolved once any in-flight or pending backup is fully flushed.
async function flushAll(forceFinal = false) {
  if (fastTimer) { clearTimeout(fastTimer); fastTimer = null; }
  if (pendingPromise) { try { await pendingPromise; } catch {} }
  if (dirty || forceFinal) {
    dirty = false;
    try { await uploadBackup(true); } catch {}
  }
}

function reconfigure({ token, repo, branch, intervalSec }) {
  if (token) TOKEN = token;
  if (repo) REPO = repo;
  if (branch) BRANCH = branch;
  if (intervalSec) INTERVAL = intervalSec * 1000;
  lastSha = null; lastHash = null;
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  startPeriodicBackup();
  console.log(`✅ Backup reconfigured: ${REPO} (every ${INTERVAL / 1000}s)`);
}

// Read the working token from a small config file we keep in the backup repo itself.
// This is the chicken-and-egg solution: env token may be expired, DB is gone on fresh container,
// but the config repo can be read with any token that still has access (or even a public read if marked so).
async function tryFetchRemoteConfig() {
  // Try env token first to fetch the config file. If env token is bad, we are stuck — caller falls back to local.
  if (!TOKEN || !REPO) return null;
  try {
    const file = await gh('GET', `/repos/${REPO}/contents/${CONFIG_PATH}?ref=${BRANCH}`);
    if (!file || !file.content) return null;
    const enc = Buffer.from(file.content, 'base64').toString('utf8');
    const crypto = require('crypto');
    const JWT = process.env.JWT_SECRET || 'hivemind-fallback-' + (process.env.RENDER_INSTANCE_ID || 'local');
    const [ivHex, dataHex] = enc.split(':');
    if (!ivHex || !dataHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(JWT).digest();
    const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const json = Buffer.concat([dec.update(Buffer.from(dataHex, 'hex')), dec.final()]).toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && parsed.token && parsed.repo ? parsed : null;
  } catch (e) {
    return null;  // env token can't even read the config file — we are stuck on env token only
  }
}

async function saveRemoteConfig(token, repo) {
  if (!TOKEN || !REPO) return false;
  try {
    const crypto = require('crypto');
    const JWT = process.env.JWT_SECRET || 'hivemind-fallback-' + (process.env.RENDER_INSTANCE_ID || 'local');
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(JWT).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify({ token, repo }), 'utf8'), cipher.final()]);
    const payload = iv.toString('hex') + ':' + enc.toString('hex');
    let sha = null;
    try { const f = await gh('GET', `/repos/${REPO}/contents/${CONFIG_PATH}?ref=${BRANCH}`); sha = f.sha; } catch {}
    const body = { message: 'Update working config', content: Buffer.from(payload).toString('base64'), branch: BRANCH };
    if (sha) body.sha = sha;
    await gh('PUT', `/repos/${REPO}/contents/${CONFIG_PATH}`, body);
    return true;
  } catch (e) {
    console.warn('⚠ Could not save remote config:', e.message);
    return false;
  }
}

// Read the encrypted runtime config without loading db.js (which would create a fresh DB file).
// We open the existing DB file directly read-only if it exists; otherwise no runtime config.
function tryLoadRuntimeConfig() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const Database = require('better-sqlite3');
    const ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    let tokenEnc = null, repo = null;
    try {
      const t = ro.prepare("SELECT value FROM app_config WHERE key='github_token'").get();
      const r = ro.prepare("SELECT value FROM app_config WHERE key='github_backup_repo'").get();
      tokenEnc = t?.value; repo = r?.value;
    } catch {}
    ro.close();
    if (!tokenEnc || !repo) return null;
    // Decrypt using same scheme as admin.js
    const crypto = require('crypto');
    const JWT = process.env.JWT_SECRET || 'hivemind-fallback-' + (process.env.RENDER_INSTANCE_ID || 'local');
    const [ivHex, dataHex] = String(tokenEnc).split(':');
    if (!ivHex || !dataHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(JWT).digest();
    const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const token = Buffer.concat([dec.update(Buffer.from(dataHex, 'hex')), dec.final()]).toString('utf8');
    return { token, repo };
  } catch (e) {
    console.warn('⚠ Could not read runtime backup config from DB:', e.message);
    return null;
  }
}

module.exports = {
  get enabled() { return isEnabled(); },
  reconfigure,
  saveRemoteConfig,
  async init() {
    // Step 1: try runtime config saved in (still-existing) local DB file from a prior restart.
    const localRuntime = tryLoadRuntimeConfig();
    if (localRuntime && localRuntime.token && localRuntime.repo) {
      TOKEN = localRuntime.token;
      REPO = localRuntime.repo;
      console.log('🔑 Using LOCAL runtime backup config');
    }
    // Step 2: try to fetch the working token from the backup repo itself.
    // This handles the case where env token is stale but the backup repo has a fresher one.
    const remoteCfg = await tryFetchRemoteConfig();
    if (remoteCfg && remoteCfg.token && remoteCfg.repo) {
      TOKEN = remoteCfg.token;
      REPO = remoteCfg.repo;
      console.log('🔑 Using REMOTE working config from backup repo (overrides env)');
    }
    if (!isEnabled()) {
      console.log('ℹ GitHub backup disabled (no env vars or runtime config)');
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
  triggerBackupSoon,
  flushAll,
};
