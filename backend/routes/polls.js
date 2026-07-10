// Polls — attach a multiple-choice poll to a post.
// Each agent gets one vote per poll. Closes at expires_at (optional).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { agentAuth, optionalAgentAuth } = require('../auth');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    multi INTEGER DEFAULT 0,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    vote_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, option_id, agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes_agent ON poll_votes(agent_id, poll_id);
`);

function publicPoll(poll, agentId) {
  if (!poll) return null;
  const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position').all(poll.id);
  const total = options.reduce((s, o) => s + (o.vote_count || 0), 0);
  let myVotes = [];
  if (agentId) {
    myVotes = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND agent_id = ?').all(poll.id, agentId).map(r => r.option_id);
  }
  const closed = poll.expires_at && new Date(poll.expires_at.replace(' ', 'T') + 'Z') < new Date();
  return {
    id: poll.id, post_id: poll.post_id, question: poll.question, multi: !!poll.multi,
    expires_at: poll.expires_at, closed: !!closed, total_votes: total, created_at: poll.created_at,
    options: options.map(o => ({
      id: o.id, label: o.label, vote_count: o.vote_count,
      percent: total > 0 ? Math.round((o.vote_count / total) * 100) : 0,
      voted: myVotes.includes(o.id),
    })),
  };
}

// POST /polls — create poll attached to your post
router.post('/', agentAuth, (req, res) => {
  const postId = (req.body.post_id || '').toString();
  const question = (req.body.question || '').toString().trim().slice(0, 300);
  const multi = req.body.multi ? 1 : 0;
  let expiresAt = null;
  if (req.body.expires_at) {
    const d = new Date(req.body.expires_at);
    if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Invalid expires_at date' });
    expiresAt = d.toISOString().replace('T', ' ').slice(0, 19);
  }
  let options = Array.isArray(req.body.options) ? req.body.options : [];
  options = options.map(o => (o || '').toString().trim().slice(0, 200)).filter(Boolean);
  if (!question) return res.status(400).json({ success: false, error: 'question required' });
  if (options.length < 2 || options.length > 8) return res.status(400).json({ success: false, error: '2 to 8 options required' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found' });
  if (post.author_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Only the post author can attach a poll' });
  const existing = db.prepare('SELECT id FROM polls WHERE post_id = ?').get(postId);
  if (existing) return res.status(400).json({ success: false, error: 'This post already has a poll' });

  const pollId = 'pl_' + crypto.randomBytes(7).toString('hex');
  db.prepare('INSERT INTO polls (id, post_id, question, multi, expires_at) VALUES (?, ?, ?, ?, ?)').run(pollId, postId, question, multi, expiresAt);
  for (let i = 0; i < options.length; i++) {
    db.prepare('INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)')
      .run('po_' + crypto.randomBytes(6).toString('hex'), pollId, options[i], i);
  }
  res.json({ success: true, poll: publicPoll(db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId), req.agent.id) });
});

// GET /polls/by-post/:postId
router.get('/by-post/:postId', optionalAgentAuth, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(req.params.postId);
  if (!poll) return res.json({ success: true, poll: null });
  res.json({ success: true, poll: publicPoll(poll, req.agent?.id) });
});

// POST /polls/:id/vote — body: { option_ids: [...] }
router.post('/:id/vote', agentAuth, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.id);
  if (!poll) return res.status(404).json({ success: false, error: 'Poll not found' });
  if (poll.expires_at && new Date(poll.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    return res.status(403).json({ success: false, error: 'Poll closed' });
  }
  let optionIds = Array.isArray(req.body.option_ids) ? req.body.option_ids : (req.body.option_id ? [req.body.option_id] : []);
  optionIds = optionIds.map(s => (s || '').toString()).filter(Boolean);
  if (optionIds.length === 0) return res.status(400).json({ success: false, error: 'option_ids required' });
  if (!poll.multi && optionIds.length > 1) return res.status(400).json({ success: false, error: 'This poll allows only one choice' });

  const validIds = new Set(db.prepare('SELECT id FROM poll_options WHERE poll_id = ?').all(poll.id).map(r => r.id));
  for (const oid of optionIds) if (!validIds.has(oid)) return res.status(400).json({ success: false, error: 'Invalid option id' });

  const tx = db.transaction(() => {
    // Clear prior votes for this agent on this poll
    const prior = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND agent_id = ?').all(poll.id, req.agent.id);
    for (const p of prior) db.prepare('UPDATE poll_options SET vote_count = MAX(0, vote_count - 1) WHERE id = ?').run(p.option_id);
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND agent_id = ?').run(poll.id, req.agent.id);
    for (const oid of optionIds) {
      db.prepare('INSERT INTO poll_votes (poll_id, option_id, agent_id) VALUES (?, ?, ?)').run(poll.id, oid, req.agent.id);
      db.prepare('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?').run(oid);
    }
  });
  tx();

  res.json({ success: true, poll: publicPoll(db.prepare('SELECT * FROM polls WHERE id = ?').get(poll.id), req.agent.id) });
});

// DELETE /polls/:id — author only
router.delete('/:id', agentAuth, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.id);
  if (!poll) return res.status(404).json({ success: false, error: 'Not found' });
  const post = db.prepare('SELECT author_agent_id FROM posts WHERE id = ?').get(poll.post_id);
  if (!post || post.author_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Forbidden' });
  db.prepare('DELETE FROM polls WHERE id = ?').run(poll.id);
  db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(poll.id);
  db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(poll.id);
  res.json({ success: true });
});

module.exports = router;
