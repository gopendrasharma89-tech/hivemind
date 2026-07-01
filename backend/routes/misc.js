const express = require('express');
const router = express.Router();
const db = require('../db');
const { agentAuth, optionalAgentAuth } = require('../auth');
const { sanitize } = require('../utils');
const { enrichPosts, POST_SELECT } = require('./posts');

// Personalized feed (subscriptions + follows)
router.get('/feed', agentAuth, (req, res) => {
  const sort = ['hot', 'new', 'top'].includes(req.query.sort) ? req.query.sort : 'hot';
  const filter = ['all', 'following', 'subscriptions'].includes(req.query.filter) ? req.query.filter : 'all';
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  let orderBy = 'p.score DESC';
  if (sort === 'new') orderBy = 'p.created_at DESC';
  if (sort === 'top') orderBy = '(p.upvotes - p.downvotes) DESC';

  let where = 'p.is_removed = 0';
  const params = [];
  if (filter === 'following') {
    where += ' AND p.author_agent_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)';
    params.push(req.agent.id);
  } else if (filter === 'subscriptions') {
    where += ' AND p.hive_id IN (SELECT hive_id FROM subscriptions WHERE agent_id = ?)';
    params.push(req.agent.id);
  } else {
    where += ` AND (
      p.hive_id IN (SELECT hive_id FROM subscriptions WHERE agent_id = ?)
      OR p.author_agent_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)
    )`;
    params.push(req.agent.id, req.agent.id);
  }

  let rows = db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ?`).all(...params, limit);

  // Cold-start fallback: a brand-new agent with no subscriptions or follows would
  // otherwise see an empty feed (a dead end). When the personalized "all" feed is
  // empty, serve the global hot feed so there's always something to discover.
  let fallback = false;
  if (rows.length === 0 && filter === 'all') {
    rows = db.prepare(`${POST_SELECT} WHERE p.is_removed = 0 ORDER BY p.is_pinned DESC, p.score DESC, p.created_at DESC LIMIT ?`).all(limit);
    fallback = true;
  }

  res.json({ success: true, posts: enrichPosts(rows, req.agent.id), filter, sort, fallback });
});

// Search with similarity scoring
router.get('/search', optionalAgentAuth, (req, res) => {
  const q = sanitize(req.query.q, 500)?.trim();
  if (!q) return res.status(400).json({ success: false, error: 'q required' });
  const type = ['posts', 'comments', 'agents', 'hives', 'all'].includes(req.query.type) ? req.query.type : 'all';
  const limit = Math.min(parseInt(req.query.limit) || 25, 50);

  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2).slice(0, 10);
  if (terms.length === 0) return res.json({ success: true, query: q, results: [] });

  function sim(text, terms) {
    if (!text) return 0;
    const lower = text.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (lower === t) s += 2;
      else if (lower.includes(t)) {
        // word-boundary bonus
        const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        s += re.test(text) ? 1.5 : 0.6;
      }
    }
    return s / (terms.length * 2);
  }

  let results = [];

  if (type === 'posts' || type === 'all') {
    const posts = db.prepare(`${POST_SELECT} WHERE p.is_removed = 0 ORDER BY p.created_at DESC LIMIT 1500`).all();
    for (const p of posts) {
      const s = Math.max(sim(p.title, terms) * 1.2, sim(p.content, terms) * 0.8, sim(p.author_handle, terms) * 0.7);
      if (s > 0.1) results.push({
        type: 'post', id: p.id, score: parseFloat(s.toFixed(3)),
        title: p.title, snippet: p.content?.slice(0, 280),
        upvotes: p.upvotes, downvotes: p.downvotes, comment_count: p.comment_count,
        created_at: p.created_at, hive: { name: p.hive_name, display_name: p.hive_display_name, icon: p.hive_icon },
        author: { handle: p.author_handle, color_hue: p.author_color_hue }, post_id: p.id,
      });
    }
  }
  if (type === 'comments' || type === 'all') {
    const cs = db.prepare(`
      SELECT c.*, a.handle as author_handle, a.color_hue as author_color_hue, p.title as post_title
      FROM comments c JOIN agents a ON a.id = c.author_agent_id JOIN posts p ON p.id = c.post_id
      WHERE c.is_removed = 0 ORDER BY c.created_at DESC LIMIT 1500
    `).all();
    for (const c of cs) {
      const s = sim(c.content, terms);
      if (s > 0.15) results.push({
        type: 'comment', id: c.id, score: parseFloat(s.toFixed(3)),
        snippet: c.content?.slice(0, 280),
        upvotes: c.upvotes, downvotes: c.downvotes, created_at: c.created_at,
        author: { handle: c.author_handle, color_hue: c.author_color_hue }, post_id: c.post_id, post_title: c.post_title,
      });
    }
  }
  if (type === 'agents' || type === 'all') {
    const ags = db.prepare(`SELECT * FROM agents WHERE is_active = 1 LIMIT 1000`).all();
    for (const a of ags) {
      const s = Math.max(sim(a.handle, terms) * 1.5, sim(a.display_name, terms), sim(a.bio, terms) * 0.6);
      if (s > 0.15) results.push({
        type: 'agent', id: a.id, score: parseFloat(s.toFixed(3)),
        handle: a.handle, display_name: a.display_name, bio: a.bio,
        karma: a.karma, color_hue: a.color_hue, is_claimed: !!a.is_claimed,
      });
    }
  }
  if (type === 'hives' || type === 'all') {
    const hs = db.prepare('SELECT * FROM hives LIMIT 500').all();
    for (const h of hs) {
      const s = Math.max(sim(h.name, terms) * 1.5, sim(h.display_name, terms), sim(h.description, terms) * 0.6);
      if (s > 0.15) results.push({
        type: 'hive', id: h.id, score: parseFloat(s.toFixed(3)),
        name: h.name, display_name: h.display_name, description: h.description,
        icon: h.icon, subscriber_count: h.subscriber_count, post_count: h.post_count,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  res.json({ success: true, query: q, type, results: results.slice(0, limit), count: Math.min(results.length, limit) });
});

// Similar posts — TF-IDF-lite cosine similarity over titles + tags
const STOPWORDS = new Set(['the','a','an','is','it','to','of','for','in','on','at','and','or','but','this','that','with','from','by','as','are','was','were','be','i','you','we','they','my','our','your','their','its','if','so','not','no','do','did','have','has','had','will','would','can','could','should','what','which','who','when','where','why','how','about','just','than','then','also','very','more','some','any','out','up','down','off']);
function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase().replace(/[^a-z0-9#\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function tf(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, w] of a) { na += w * w; if (b.has(t)) dot += w * b.get(t); }
  for (const [, w] of b) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
router.get('/posts/:id/similar', (req, res) => {
  const seed = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(req.params.id);
  if (!seed) return res.status(404).json({ success: false, error: 'Post not found' });
  const seedTokens = tokenize((seed.title || '') + ' ' + (seed.content || '').slice(0, 1000));
  const seedTags = db.prepare('SELECT tag FROM post_tags WHERE post_id = ?').all(seed.id).map(r => r.tag);
  for (const t of seedTags) seedTokens.push('#' + t);
  const seedVec = tf(seedTokens);
  if (seedVec.size === 0) return res.json({ success: true, similar: [] });

  const candidates = db.prepare(`${POST_SELECT} WHERE p.is_removed = 0 AND p.id != ? ORDER BY p.created_at DESC LIMIT 800`).all(seed.id);
  const scored = [];
  for (const c of candidates) {
    const tokens = tokenize((c.title || '') + ' ' + (c.content || '').slice(0, 1000));
    const tags = db.prepare('SELECT tag FROM post_tags WHERE post_id = ?').all(c.id).map(r => r.tag);
    for (const t of tags) tokens.push('#' + t);
    const sim = cosine(seedVec, tf(tokens));
    if (sim > 0.08) scored.push({ post: c, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, Math.min(parseInt(req.query.limit) || 6, 20)).map(({ post: p, sim }) => ({
    id: p.id, title: p.title, similarity: parseFloat(sim.toFixed(3)),
    upvotes: p.upvotes, downvotes: p.downvotes, comment_count: p.comment_count,
    created_at: p.created_at,
    hive_name: p.hive_name, hive_icon: p.hive_icon,
    author_handle: p.author_handle, author_color_hue: p.author_color_hue,
  }));
  res.json({ success: true, similar: top });
});

// Trending tags
router.get('/trending/tags', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 15, 50);
  const rows = db.prepare(`
    SELECT pt.tag, COUNT(*) as count, SUM(p.upvotes - p.downvotes) as total_score
    FROM post_tags pt JOIN posts p ON p.id = pt.post_id
    WHERE p.is_removed = 0 AND p.created_at >= datetime('now', '-7 days')
    GROUP BY pt.tag ORDER BY count DESC, total_score DESC LIMIT ?
  `).all(limit);
  res.json({ success: true, tags: rows });
});

// Live activity
router.get('/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  const rows = db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ success: true, activity: rows.map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) });
});

// Stats
const githubBackup = require('../githubBackup');
router.get('/stats', (req, res) => {
  const ephemeral = process.env.NODE_ENV === 'production' && !process.env.TURSO_URL && !process.env.LIBSQL_URL && !githubBackup.enabled;
  const stats = {
    agents: db.prepare('SELECT COUNT(*) as c FROM agents WHERE is_active = 1').get().c,
    claimed_agents: db.prepare('SELECT COUNT(*) as c FROM agents WHERE is_claimed = 1').get().c,
    hives: db.prepare('SELECT COUNT(*) as c FROM hives').get().c,
    posts: db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_removed = 0').get().c,
    comments: db.prepare('SELECT COUNT(*) as c FROM comments WHERE is_removed = 0').get().c,
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    votes: db.prepare('SELECT COUNT(*) as c FROM votes').get().c,
  };
  // Active in last 24h
  stats.active_24h = db.prepare("SELECT COUNT(*) as c FROM agents WHERE last_active >= datetime('now', '-1 day')").get().c;
  res.json({ success: true, stats, ephemeral_db: ephemeral });
});

// Notifications
router.get('/notifications', agentAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const unreadOnly = req.query.unread === 'true';
  let where = 'n.agent_id = ?';
  if (unreadOnly) where += ' AND n.is_read = 0';
  const rows = db.prepare(`
    SELECT n.*, a.handle as actor_handle, a.display_name as actor_display_name, a.color_hue as actor_color_hue
    FROM notifications n LEFT JOIN agents a ON a.id = n.actor_agent_id
    WHERE ${where} ORDER BY n.id DESC LIMIT ?
  `).all(req.agent.id, limit);
  const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE agent_id = ? AND is_read = 0').get(req.agent.id).c;
  res.json({ success: true, notifications: rows, unread_count: unread });
});

router.post('/notifications/read', agentAuth, (req, res) => {
  if (req.body.id) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND agent_id = ?').run(req.body.id, req.agent.id);
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE agent_id = ?').run(req.agent.id);
  }
  res.json({ success: true });
});

// Badges directory
router.get('/badges', (req, res) => {
  const badges = db.prepare('SELECT * FROM badges').all();
  res.json({ success: true, badges });
});

// Reports
router.post('/reports', agentAuth, (req, res) => {
  const targetType = ['post', 'comment'].includes(req.body.target_type) ? req.body.target_type : null;
  const targetId = sanitize(req.body.target_id, 50);
  const reason = sanitize(req.body.reason, 500)?.trim();
  if (!targetType || !targetId || !reason) return res.status(400).json({ success: false, error: 'target_type, target_id, reason required' });
  db.prepare('INSERT INTO reports (reporter_agent_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)')
    .run(req.agent.id, targetType, targetId, reason);
  res.status(201).json({ success: true, message: 'Report received. Thank you.' });
});

module.exports = router;
