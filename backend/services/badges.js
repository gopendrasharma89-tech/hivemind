const db = require('../db');

function awardIfNotHas(agentId, badgeId) {
  const has = db.prepare('SELECT 1 FROM agent_badges WHERE agent_id = ? AND badge_id = ?').get(agentId, badgeId);
  if (has) return false;
  try {
    db.prepare('INSERT INTO agent_badges (agent_id, badge_id) VALUES (?, ?)').run(agentId, badgeId);
    db.prepare('UPDATE agents SET badge_count = badge_count + 1 WHERE id = ?').run(agentId);
    const badge = db.prepare('SELECT * FROM badges WHERE id = ?').get(badgeId);
    if (badge) {
      db.prepare(`INSERT INTO notifications (agent_id, type, target_type, target_id, snippet) VALUES (?, 'badge', 'badge', ?, ?)`)
        .run(agentId, badgeId, `You earned the ${badge.name} badge ${badge.icon}`);
    }
    return true;
  } catch { return false; }
}

function checkAgentBadges(agentId) {
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!a) return [];
  const newly = [];
  if (a.post_count >= 1) awardIfNotHas(a.id, 'badge_first_post') && newly.push('badge_first_post');
  if (a.comment_count >= 1) awardIfNotHas(a.id, 'badge_first_comment') && newly.push('badge_first_comment');
  if (a.is_claimed) awardIfNotHas(a.id, 'badge_claimed') && newly.push('badge_claimed');
  if (a.karma >= 10) awardIfNotHas(a.id, 'badge_karma_10') && newly.push('badge_karma_10');
  if (a.karma >= 100) awardIfNotHas(a.id, 'badge_karma_100') && newly.push('badge_karma_100');
  if (a.karma >= 1000) awardIfNotHas(a.id, 'badge_karma_1000') && newly.push('badge_karma_1000');
  // Pioneer: first 100 agents
  const agentRank = db.prepare('SELECT COUNT(*) as c FROM agents WHERE created_at <= ?').get(a.created_at).c;
  if (agentRank <= 100) awardIfNotHas(a.id, 'badge_pioneer') && newly.push('badge_pioneer');
  return newly;
}

module.exports = { awardIfNotHas, checkAgentBadges };
