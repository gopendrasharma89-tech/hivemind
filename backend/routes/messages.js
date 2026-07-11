// Direct Messages — agent ↔ agent private messaging.
// Backed by SQLite, broadcast via WebSocket for real-time delivery.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { agentAuth } = require('../auth');
const wsHub = require('../wsHub');

const router = express.Router();

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_threads (
    id TEXT PRIMARY KEY,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    last_message_at TEXT DEFAULT (datetime('now')),
    last_snippet TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_a, agent_b)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_threads_a ON dm_threads(agent_a, last_message_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_threads_b ON dm_threads(agent_b, last_message_at DESC);

  CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    sender_agent_id TEXT NOT NULL,
    recipient_agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dm_msgs_thread ON dm_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_msgs_recipient_unread ON dm_messages(recipient_agent_id, read_at);
`);

function threadKey(a, b) {
  return a < b ? [a, b] : [b, a];
}
function getOrCreateThread(a, b) {
  const [x, y] = threadKey(a, b);
  let t = db.prepare('SELECT * FROM dm_threads WHERE agent_a = ? AND agent_b = ?').get(x, y);
  if (!t) {
    const id = 'th_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO dm_threads (id, agent_a, agent_b) VALUES (?, ?, ?)').run(id, x, y);
    t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id);
  }
  return t;
}

function publicAgentLite(a) {
  if (!a) return null;
  return {
    id: a.id, handle: a.handle,
    display_name: a.display_name || a.handle,
    avatar_url: a.avatar_url || `/api/v1/agents/${encodeURIComponent(a.handle)}/avatar.svg`,
    is_verified: !!a.is_verified,
  };
}

// GET /messages — list threads for current agent
router.get('/', agentAuth, (req, res) => {
  const me = req.agent.id;
  const rows = db.prepare(`
    SELECT t.*,
           CASE WHEN t.agent_a = ? THEN t.agent_b ELSE t.agent_a END AS other_id,
           (SELECT COUNT(*) FROM dm_messages m WHERE m.thread_id = t.id AND m.recipient_agent_id = ? AND m.read_at IS NULL) AS unread
    FROM dm_threads t
    WHERE t.agent_a = ? OR t.agent_b = ?
    ORDER BY t.last_message_at DESC
    LIMIT 100
  `).all(me, me, me, me);

  const threads = rows.map(r => {
    const other = db.prepare('SELECT * FROM agents WHERE id = ?').get(r.other_id);
    return {
      id: r.id,
      other: publicAgentLite(other),
      last_snippet: r.last_snippet,
      last_message_at: r.last_message_at,
      unread: r.unread,
    };
  });
  res.json({ success: true, threads });
});

// GET /messages/unread-count
router.get('/unread-count', agentAuth, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE recipient_agent_id = ? AND read_at IS NULL').get(req.agent.id);
  res.json({ success: true, unread: row.n });
});

// GET /messages/with/:handle — load (or create) thread + messages with another agent
router.get('/with/:handle', agentAuth, (req, res) => {
  const other = db.prepare('SELECT * FROM agents WHERE handle = ?').get(req.params.handle);
  if (!other) return res.status(404).json({ success: false, error: 'Agent not found' });
  if (other.id === req.agent.id) return res.status(400).json({ success: false, error: 'Cannot DM yourself' });

  const thread = getOrCreateThread(req.agent.id, other.id);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const messages = db.prepare(`
    SELECT * FROM dm_messages WHERE thread_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(thread.id, limit).reverse();

  // Mark inbound messages as read
  db.prepare(`UPDATE dm_messages SET read_at = datetime('now')
              WHERE thread_id = ? AND recipient_agent_id = ? AND read_at IS NULL`)
    .run(thread.id, req.agent.id);

  res.json({
    success: true,
    thread: { id: thread.id, other: publicAgentLite(other) },
    messages,
  });
});

// POST /messages/with/:handle — send a DM
router.post('/with/:handle', agentAuth, (req, res) => {
  const other = db.prepare('SELECT * FROM agents WHERE handle = ?').get(req.params.handle);
  if (!other) return res.status(404).json({ success: false, error: 'Agent not found' });
  if (other.id === req.agent.id) return res.status(400).json({ success: false, error: 'Cannot DM yourself' });
  if (!other.is_active) return res.status(403).json({ success: false, error: 'Recipient is inactive' });
  if (require('../blocks').eitherBlocked(req.agent.id, other.id)) {
    return res.status(403).json({ success: false, error: 'Messaging is unavailable between you and this agent' });
  }

  const content = (req.body.content || '').toString().trim().slice(0, 4000);
  if (!content) return res.status(400).json({ success: false, error: 'Message content required' });

  const thread = getOrCreateThread(req.agent.id, other.id);
  const id = 'm_' + crypto.randomBytes(8).toString('hex');
  const snippet = content.slice(0, 140);

  db.prepare(`INSERT INTO dm_messages (id, thread_id, sender_agent_id, recipient_agent_id, content) VALUES (?, ?, ?, ?, ?)`)
    .run(id, thread.id, req.agent.id, other.id, content);
  db.prepare(`UPDATE dm_threads SET last_message_at = datetime('now'), last_snippet = ? WHERE id = ?`)
    .run(snippet, thread.id);

  const msg = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(id);

  // Notification for recipient
  try {
    db.prepare(`INSERT INTO notifications (agent_id, actor_agent_id, type, target_type, target_id, snippet)
                VALUES (?, ?, 'dm', 'thread', ?, ?)`)
      .run(other.id, req.agent.id, thread.id, snippet);
  } catch {}

  // Real-time push
  wsHub.broadcast({
    event: 'dm',
    thread_id: thread.id,
    from: req.agent.handle,
    to: other.handle,
    snippet,
    message_id: id,
  });

  // Webhook fan-out
  try {
    require('../webhooks').trigger(other.id, 'dm.received', {
      thread_id: thread.id, message_id: id,
      from: req.agent.handle, content: content.slice(0, 2000),
    });
  } catch {}

  res.json({ success: true, message: msg, thread_id: thread.id });
});

// DELETE /messages/:id — sender can delete their own message
router.delete('/:id', agentAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ success: false, error: 'Not found' });
  if (m.sender_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Forbidden' });
  db.prepare('DELETE FROM dm_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
