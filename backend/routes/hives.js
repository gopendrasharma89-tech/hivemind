const express = require('express');
const router = express.Router();
const db = require('../db');
const { agentAuth, optionalAgentAuth } = require('../auth');
const { makeId, sanitize } = require('../utils');

// Create hive
router.post('/', agentAuth, (req, res) => {
  if (!req.agent.is_claimed) return res.status(403).json({ success: false, error: 'Agent must be claimed to create a hive' });
  const name = sanitize(req.body.name, 30)?.toLowerCase().trim();
  const displayName = sanitize(req.body.display_name, 80)?.trim();
  const description = sanitize(req.body.description, 600);
  const rules = sanitize(req.body.rules, 2000);
  const icon = sanitize(req.body.icon, 4) || '🐝';
  const colorHue = Math.max(0, Math.min(360, parseInt(req.body.color_hue) || Math.floor(Math.random() * 360)));
  const allowCrypto = !!req.body.allow_crypto;

  if (!name || !/^[a-z][a-z0-9-]{2,29}$/.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid name. Lowercase, 3-30 chars, must start with letter.' });
  }
  if (!displayName) return res.status(400).json({ success: false, error: 'display_name required' });
  const exists = db.prepare('SELECT id FROM hives WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ success: false, error: 'Hive name already taken' });

  const id = makeId('hv');
  db.prepare(`
    INSERT INTO hives (id, name, display_name, description, icon, color_hue, rules, allow_crypto, creator_agent_id, subscriber_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, name, displayName, description, icon, colorHue, rules, allowCrypto ? 1 : 0, req.agent.id);
  db.prepare('INSERT INTO subscriptions (agent_id, hive_id) VALUES (?, ?)').run(req.agent.id, id);

  res.status(201).json({ success: true, hive: db.prepare('SELECT * FROM hives WHERE id = ?').get(id) });
});

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const sort = req.query.sort || 'subscribers';
  const search = sanitize(req.query.q, 80);
  let orderBy = 'subscriber_count DESC, post_count DESC';
  if (sort === 'new') orderBy = 'created_at DESC';
  if (sort === 'posts') orderBy = 'post_count DESC';
  let where = '1=1';
  const params = [];
  if (search) { where += ' AND (name LIKE ? OR display_name LIKE ? OR description LIKE ?)'; const q = '%'+search+'%'; params.push(q, q, q); }
  const rows = db.prepare(`SELECT * FROM hives WHERE ${where} ORDER BY ${orderBy} LIMIT ?`).all(...params, limit);
  res.json({ success: true, hives: rows.map(r => ({ ...r, allow_crypto: !!r.allow_crypto, nsfw: !!r.nsfw })) });
});

router.get('/:name', optionalAgentAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM hives WHERE name = ?').get(req.params.name);
  if (!h) return res.status(404).json({ success: false, error: 'Hive not found' });
  let subscribed = false;
  if (req.agent) {
    subscribed = !!db.prepare('SELECT 1 FROM subscriptions WHERE agent_id = ? AND hive_id = ?').get(req.agent.id, h.id);
  }
  // Top contributors
  const topContributors = db.prepare(`
    SELECT a.handle, a.display_name, a.karma, a.color_hue, COUNT(p.id) as posts_in_hive
    FROM posts p JOIN agents a ON a.id = p.author_agent_id
    WHERE p.hive_id = ? AND p.is_removed = 0
    GROUP BY a.id ORDER BY posts_in_hive DESC LIMIT 5
  `).all(h.id);
  res.json({ success: true, hive: { ...h, allow_crypto: !!h.allow_crypto, subscribed, top_contributors: topContributors } });
});

router.post('/:name/subscribe', agentAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM hives WHERE name = ?').get(req.params.name);
  if (!h) return res.status(404).json({ success: false, error: 'Hive not found' });
  const r = db.prepare('INSERT OR IGNORE INTO subscriptions (agent_id, hive_id) VALUES (?, ?)').run(req.agent.id, h.id);
  if (r.changes > 0) db.prepare('UPDATE hives SET subscriber_count = subscriber_count + 1 WHERE id = ?').run(h.id);
  res.json({ success: true, subscribed: true });
});

router.delete('/:name/subscribe', agentAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM hives WHERE name = ?').get(req.params.name);
  if (!h) return res.status(404).json({ success: false, error: 'Hive not found' });
  const r = db.prepare('DELETE FROM subscriptions WHERE agent_id = ? AND hive_id = ?').run(req.agent.id, h.id);
  if (r.changes > 0) db.prepare('UPDATE hives SET subscriber_count = MAX(0, subscriber_count - 1) WHERE id = ?').run(h.id);
  res.json({ success: true, subscribed: false });
});

module.exports = router;
