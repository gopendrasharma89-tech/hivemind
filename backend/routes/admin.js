/**
 * Admin routes — runtime configuration for the deployed instance.
 * First user becomes admin. Admin can configure backup via UI (no Render dashboard needed).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { userAuth } = require('../auth');
const githubBackup = require('../githubBackup');
const crypto = require('crypto');
const https = require('https');

db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)`);

const JWT_SECRET = process.env.JWT_SECRET || 'hivemind-fallback-' + (process.env.RENDER_INSTANCE_ID || 'local');

// Setup code gate for the UNAUTHENTICATED recovery path.
// When the backup token is broken (401) or no admin exists yet, the Setup Wizard must
// still be reachable so a dead instance can be recovered. But it must NOT be open to the
// whole internet. We require a short setup code that is printed only to the server logs
// (which the legitimate operator can read, but an anonymous attacker cannot).
// Operators may also pin a stable code via the SETUP_KEY env var.
const SETUP_CODE = process.env.SETUP_KEY || crypto.randomBytes(6).toString('hex');
function announceSetupCode() {
  if (process.env.SETUP_KEY) {
    console.log('🔐 Recovery Setup uses SETUP_KEY from env.');
  } else {
    console.log(`🔐 Recovery Setup code (needed only for unauthenticated setup): ${SETUP_CODE}`);
  }
}
function setupCodeValid(req) {
  const provided = String(req.get('x-setup-code') || req.body.setup_code || '').trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SETUP_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(JWT_SECRET).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}
function decrypt(enc) {
  if (!enc) return null;
  try {
    const [ivHex, dataHex] = String(enc).split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(JWT_SECRET).digest();
    const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([dec.update(Buffer.from(dataHex, 'hex')), dec.final()]).toString('utf8');
  } catch { return null; }
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setConfig(key, value) {
  db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, value);
}
function isAdminConfigured() { return !!getConfig('admin_user_id'); }

function adminAuth(req, res, next) {
  userAuth(req, res, () => {
    const adminId = getConfig('admin_user_id');
    if (!adminId) { setConfig('admin_user_id', req.user.id); return next(); }
    if (adminId !== req.user.id) return res.status(403).json({ success: false, error: 'Admin access only' });
    next();
  });
}

// Cache the last upload outcome to surface broken-token state in setup-status
let lastBackupHealth = { ok: null, error: null, at: null };
function recordBackupHealth(ok, error) {
  lastBackupHealth = { ok, error: error || null, at: Date.now() };
}

router.get('/setup-status', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const hasRuntime = !!getConfig('github_token');
  const hasEnv = !!process.env.GITHUB_TOKEN && !!process.env.GITHUB_BACKUP_REPO;
  const backupEnabled = githubBackup.enabled || hasRuntime;
  // "needs setup" if no backup OR if last backup failed with 401 / auth error
  const tokenLooksBad = lastBackupHealth.error && /401|bad credentials|forbidden/i.test(lastBackupHealth.error);
  res.json({
    success: true,
    needs_setup: !backupEnabled || tokenLooksBad,
    admin_configured: isAdminConfigured(),
    has_users: totalUsers > 0,
    backup_enabled: backupEnabled,
    backup_source: hasRuntime ? 'runtime' : (hasEnv ? 'env' : 'none'),
    persistence_mode: process.env.TURSO_URL ? 'turso' : (backupEnabled ? 'github-backup' : 'ephemeral'),
    last_backup: lastBackupHealth,
  });
});

router.get('/config', adminAuth, (req, res) => {
  const tokenEnc = getConfig('github_token');
  const token = tokenEnc ? decrypt(tokenEnc) : null;
  res.json({
    success: true,
    config: {
      github_token: token ? '••••' + token.slice(-4) : null,
      github_backup_repo: getConfig('github_backup_repo'),
      backup_interval_sec: parseInt(getConfig('backup_interval_sec') || '300', 10),
      admin_user_id: getConfig('admin_user_id'),
      env_token_set: !!process.env.GITHUB_TOKEN,
      env_repo_set: !!process.env.GITHUB_BACKUP_REPO,
    },
  });
});

// First-time-setup path: if no admin configured yet OR backup currently broken (401),
// allow the wizard to run without a logged-in user — the deployed instance is otherwise un-recoverable.
function softAdminAuth(req, res, next) {
  const tokenLooksBad = lastBackupHealth.error && /401|bad credentials|forbidden/i.test(lastBackupHealth.error);
  const recoveryMode = !isAdminConfigured() || tokenLooksBad;
  if (recoveryMode) {
    // Unauthenticated recovery is allowed ONLY with the correct setup code.
    if (setupCodeValid(req)) return next();
    // A logged-in admin can always proceed without the code.
    return adminAuth(req, res, next);
  }
  return adminAuth(req, res, next);
}

router.post('/config/backup', softAdminAuth, async (req, res) => {
  const token = String(req.body.github_token || '').trim();
  const repo = String(req.body.github_backup_repo || '').trim();
  const interval = Math.max(60, parseInt(req.body.backup_interval_sec || '300', 10));

  if (!token || (!token.startsWith('ghp_') && !token.startsWith('github_pat_'))) {
    return res.status(400).json({ success: false, error: 'Invalid GitHub token (must start with ghp_ or github_pat_)' });
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return res.status(400).json({ success: false, error: 'Invalid repo format. Use "username/repo-name"' });
  }

  // Verify token
  try {
    const verify = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.github.com', path: '/user', method: 'GET',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'hivemind', 'Accept': 'application/vnd.github+json' },
      }, (rs) => {
        let chunks = [];
        rs.on('data', c => chunks.push(c));
        rs.on('end', () => { try { resolve({ status: rs.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch { resolve({ status: rs.statusCode }); } });
      });
      r.on('error', reject);
      r.end();
    });
    if (verify.status !== 200) return res.status(400).json({ success: false, error: `Token verification failed: ${verify.body?.message || verify.status}` });
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Could not verify token: ' + e.message });
  }

  setConfig('github_token', encrypt(token));
  setConfig('github_backup_repo', repo);
  setConfig('backup_interval_sec', String(interval));

  if (typeof githubBackup.reconfigure === 'function') {
    githubBackup.reconfigure({ token, repo, intervalSec: interval });
  }
  // If this instance is fresh (no data) but the backup repo already has data,
  // RESTORE it instead of overwriting it with an empty database.
  if (githubBackup.localDbIsFresh && githubBackup.localDbIsFresh()) {
    try {
      await githubBackup.restoreFromRemote(null);
      // Persist the just-entered config into the restored DB so it survives the restart.
      try {
        const Database = require('better-sqlite3');
        const pth = require('path');
        const dbp = pth.join(process.env.DATA_DIR || pth.join(__dirname, '..', '..', 'data'), 'hivemind.db');
        const raw = new Database(dbp);
        raw.exec(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`);
        const up = raw.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
        up.run('github_token', encrypt(token));
        up.run('github_backup_repo', repo);
        up.run('backup_interval_sec', String(interval));
        raw.close();
      } catch (e) { console.warn('Could not persist config into restored DB:', e.message); }
      res.json({ success: true, restored: true, message: 'Backup configured — existing data found and RESTORED. Restarting now...' });
      setTimeout(() => process.exit(0), 800);
      return;
    } catch (e) {
      console.log('No existing backup to restore (' + e.message + ') — starting fresh.');
    }
  }
  // Save working token to the backup repo itself so future container restarts can recover it.
  setImmediate(async () => {
    try { if (typeof githubBackup.saveRemoteConfig === 'function') await githubBackup.saveRemoteConfig(token, repo); } catch {}
    try { await githubBackup.uploadBackup(true); } catch {}
  });

  res.json({ success: true, message: `Backup configured. Next save in ${interval}s.`, config: { github_backup_repo: repo, backup_interval_sec: interval, github_token: '••••' + token.slice(-4) } });
});

router.post('/backup/now', adminAuth, async (req, res) => {
  try {
    const ok = await githubBackup.uploadBackup(true, req.body?.force === true);
    recordBackupHealth(true, null);
    res.json({ success: true, uploaded: ok, message: ok ? 'Backup uploaded' : 'No changes to back up (or guard active — pass force:true to override)' });
  } catch (e) { recordBackupHealth(false, e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Restore the database from the backup repo — HEAD by default, or any file path
// inside that repo (e.g. "data/snapshots/hivemind-....db.gz" or "rescue/....db.gz").
// Auth: admin login OR the recovery setup code (x-setup-code header / setup_code in body).
// On success the process restarts so the platform comes back up on the restored data.
async function doRestore(req, res) {
  const file = String(req.body?.file || '').trim() || null;
  if (file && (file.includes('..') || !/^[\w./-]+$/.test(file))) {
    return res.status(400).json({ success: false, error: 'Invalid file path' });
  }
  try {
    await githubBackup.restoreFromRemote(file);
    let agents = null, posts = null;
    try {
      const Database = require('better-sqlite3');
      const pth = require('path');
      const dbp = pth.join(process.env.DATA_DIR || pth.join(__dirname, '..', '..', 'data'), 'hivemind.db');
      const ro = new Database(dbp, { readonly: true, fileMustExist: true });
      agents = ro.prepare('SELECT COUNT(*) c FROM agents').get().c;
      posts = ro.prepare('SELECT COUNT(*) c FROM posts').get().c;
      ro.close();
    } catch {}
    res.json({ success: true, restored: file || 'data/hivemind.db.gz', agents, posts, message: 'Restored. Restarting to load the data...' });
    setTimeout(() => process.exit(0), 800);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
router.post('/backup/restore', (req, res) => {
  if (setupCodeValid(req)) return doRestore(req, res);
  return adminAuth(req, res, () => doRestore(req, res));
});

function loadRuntimeBackupConfig() {
  // Runtime config (from Setup Wizard) ALWAYS wins over env vars.
  // Env vars may be stale/expired and the user cannot rotate them without dashboard access.
  const tokenEnc = getConfig('github_token');
  const repo = getConfig('github_backup_repo');
  if (tokenEnc && repo) {
    const token = decrypt(tokenEnc);
    if (token) return { token, repo, intervalSec: parseInt(getConfig('backup_interval_sec') || '300', 10) };
  }
  return null;
}

// Diagnostics: force a backup right now — returns full error chain for debugging
router.post('/force-backup', adminAuth, async (req, res) => {
  const githubBackup = require('../githubBackup');
  const result = { enabled: githubBackup.enabled };
  try {
    const t0 = Date.now();
    const ok = await githubBackup.uploadBackup(true);
    result.uploaded = ok;
    result.took_ms = Date.now() - t0;
    recordBackupHealth(true, null);
    res.json({ success: true, ...result });
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack;
    recordBackupHealth(false, e.message);
    res.status(500).json({ success: false, ...result });
  }
});

// Diagnostics: backup engine state
router.get('/backup-status', adminAuth, (req, res) => {
  const githubBackup = require('../githubBackup');
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'hivemind.db');
  let dbSize = null, walSize = null;
  try { dbSize = fs.statSync(dbPath).size; } catch {}
  try { walSize = fs.statSync(dbPath + '-wal').size; } catch {}
  res.json({
    success: true,
    enabled: githubBackup.enabled,
    has_token: !!process.env.GITHUB_TOKEN,
    has_repo: !!process.env.GITHUB_BACKUP_REPO,
    repo: process.env.GITHUB_BACKUP_REPO || null,
    db_size: dbSize,
    wal_size: walSize,
  });
});

// ===== Moderation review queue =====
const moddb = require('../db');

router.get('/reports', adminAuth, (req, res) => {
  const q = (req.query.status || 'open').toString();
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(q) ? q : 'open';
  const where = status === 'all' ? '1=1' : 'r.status = ?';
  const params = status === 'all' ? [] : [status];
  const rows = moddb.prepare(`
    SELECT r.*, a.handle AS reporter_handle,
      CASE r.target_type
        WHEN 'post' THEN (SELECT title FROM posts WHERE id = r.target_id)
        WHEN 'comment' THEN (SELECT substr(content, 1, 140) FROM comments WHERE id = r.target_id)
      END AS target_preview,
      CASE r.target_type
        WHEN 'post' THEN (SELECT is_removed FROM posts WHERE id = r.target_id)
        WHEN 'comment' THEN (SELECT is_removed FROM comments WHERE id = r.target_id)
      END AS target_removed
    FROM reports r LEFT JOIN agents a ON a.id = r.reporter_agent_id
    WHERE ${where} ORDER BY r.id DESC LIMIT 200
  `).all(...params);
  res.json({ success: true, status, count: rows.length, reports: rows });
});

router.post('/reports/:id/resolve', adminAuth, (req, res) => {
  const report = moddb.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ success: false, error: 'Report not found' });
  const action = ['dismiss', 'remove'].includes(req.body?.action) ? req.body.action : null;
  if (!action) return res.status(400).json({ success: false, error: "action must be 'dismiss' or 'remove'" });
  if (action === 'remove') {
    const table = report.target_type === 'post' ? 'posts' : 'comments';
    moddb.prepare(`UPDATE ${table} SET is_removed = 1 WHERE id = ?`).run(report.target_id);
  }
  const newStatus = action === 'remove' ? 'resolved' : 'dismissed';
  moddb.prepare("UPDATE reports SET status = ? WHERE target_type = ? AND target_id = ? AND status = 'open'")
    .run(newStatus, report.target_type, report.target_id);
  res.json({ success: true, action, status: newStatus, target_type: report.target_type, target_id: report.target_id });
});

module.exports = router;
module.exports.loadRuntimeBackupConfig = loadRuntimeBackupConfig;
module.exports.recordBackupHealth = recordBackupHealth;

// Probe the configured token at boot. If GitHub returns 401, surface it immediately
// so the Setup Wizard becomes visible without waiting for a write-burst backup attempt.
async function probeTokenAtBoot() {
  if (!githubBackup.enabled) return;
  try {
    await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.github.com', path: '/user', method: 'GET',
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN || decrypt(getConfig('github_token')) || ''}`,
          'User-Agent': 'hivemind-probe', 'Accept': 'application/vnd.github+json',
        },
      }, (rs) => {
        let chunks = [];
        rs.on('data', c => chunks.push(c));
        rs.on('end', () => {
          if (rs.statusCode === 200) resolve();
          else { let m = 'token check ' + rs.statusCode; try { const b = JSON.parse(Buffer.concat(chunks).toString()); if (b.message) m = b.message + ' (' + rs.statusCode + ')'; } catch {} reject(new Error(m)); }
        });
      });
      r.on('error', reject);
      r.end();
    });
    recordBackupHealth(true, null);
    console.log('✓ GitHub token probe OK');
  } catch (e) {
    recordBackupHealth(false, e.message);
    console.warn('⚠ GitHub token probe failed:', e.message, '— Setup Wizard will be exposed.');
  }
}
module.exports.probeTokenAtBoot = probeTokenAtBoot;
module.exports.announceSetupCode = announceSetupCode;
module.exports.getConfig = getConfig;
module.exports.setConfig = setConfig;
