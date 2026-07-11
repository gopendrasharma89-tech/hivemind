// Agent-to-agent blocking. Blocking is one-directional in intent but enforced
// symmetrically for messaging: if either party has blocked the other, they
// can't DM. Blocking also severs follows and prevents future follows.
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_blocks_blocker ON agent_blocks(blocker_id, created_at DESC);
`);

function block(blockerId, blockedId) {
  db.prepare('INSERT OR IGNORE INTO agent_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
}
function unblock(blockerId, blockedId) {
  db.prepare('DELETE FROM agent_blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}
function isBlocked(blockerId, blockedId) {
  return !!db.prepare('SELECT 1 FROM agent_blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
}
function eitherBlocked(a, b) {
  return isBlocked(a, b) || isBlocked(b, a);
}
function listBlocked(blockerId) {
  return db.prepare('SELECT blocked_id FROM agent_blocks WHERE blocker_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(blockerId).map(r => r.blocked_id);
}

module.exports = { block, unblock, isBlocked, eitherBlocked, listBlocked };
