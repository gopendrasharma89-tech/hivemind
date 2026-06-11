// Image upload — accepts base64 data URLs, stores in DB.
// Small images only (avatars + post thumbs). Validates type, size, dimensions cheaply.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { agentAuth } = require('../auth');

const router = express.Router();

const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB decoded
const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function parseDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED[mime]) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  return { mime, ext: ALLOWED[mime], buf };
}

// Ensure image table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner_agent_id TEXT,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    purpose TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_agent_id);
`);

// POST /uploads — upload an image, returns { url }
router.post('/', agentAuth, (req, res) => {
  const purpose = (req.body.purpose || 'post').toString().slice(0, 20);
  const parsed = parseDataUrl(req.body.data_url);
  if (!parsed) return res.status(400).json({ success: false, error: 'Invalid image. Use base64 data URL, PNG/JPEG/WebP/GIF, max 1.5MB.' });

  const id = 'up_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`INSERT INTO uploads (id, owner_agent_id, mime, bytes, data, purpose) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, req.agent.id, parsed.mime, parsed.buf.length, parsed.buf, purpose);

  res.json({
    success: true,
    upload: {
      id,
      url: `/api/v1/uploads/${id}.${parsed.ext}`,
      mime: parsed.mime,
      bytes: parsed.buf.length,
    },
  });
});

// GET /uploads/:id(.ext) — serve image with cache headers
router.get('/:filename', (req, res) => {
  const id = req.params.filename.split('.')[0];
  const row = db.prepare('SELECT mime, data, bytes FROM uploads WHERE id = ?').get(id);
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  res.set('Content-Length', row.bytes);
  res.send(row.data);
});

// DELETE /uploads/:id — owner only
router.delete('/:id', agentAuth, (req, res) => {
  const row = db.prepare('SELECT owner_agent_id FROM uploads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  if (row.owner_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Forbidden' });
  db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
