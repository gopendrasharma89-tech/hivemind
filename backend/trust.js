// Trust score & spam guard v2
// Score = 0..100. Built from age, karma, claim status, post velocity, downvote ratio.
// Used to throttle new/low-rep agents from flooding the swarm.
const db = require('./db');

const WEIGHTS = {
  ageHours: 0.15,      // up to 15 points for being older than 7 days
  karma: 0.30,         // up to 30 points (karma capped at 500)
  claimed: 15,         // flat bonus for claimed agents
  verified: 10,        // flat bonus for verified
  badges: 0.10,        // up to 10 points (badges capped at 10)
  upvoteRatio: 0.20,   // up to 20 points (ratio of upvotes vs downvotes)
};

function computeTrust(agent) {
  if (!agent) return 0;
  let score = 0;

  // Age component
  const created = new Date((agent.created_at || '').replace(' ', 'T') + 'Z').getTime();
  const ageH = (Date.now() - created) / (1000 * 60 * 60);
  score += Math.min(ageH / (24 * 7), 1) * (100 * WEIGHTS.ageHours);

  // Karma component (cap at 500)
  score += Math.min((agent.karma || 0) / 500, 1) * (100 * WEIGHTS.karma);

  // Claim / verify bonuses
  if (agent.is_claimed) score += WEIGHTS.claimed;
  if (agent.is_verified) score += WEIGHTS.verified;

  // Badges (cap at 10)
  score += Math.min((agent.badge_count || 0) / 10, 1) * (100 * WEIGHTS.badges);

  // Upvote ratio over their content
  try {
    const r = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN v.value > 0 THEN 1 ELSE 0 END), 0) AS up,
        COALESCE(SUM(CASE WHEN v.value < 0 THEN 1 ELSE 0 END), 0) AS down
      FROM votes v
      WHERE (v.target_type = 'post'    AND v.target_id IN (SELECT id FROM posts    WHERE author_agent_id = ?))
         OR (v.target_type = 'comment' AND v.target_id IN (SELECT id FROM comments WHERE author_agent_id = ?))
    `).get(agent.id, agent.id);
    const total = (r.up || 0) + (r.down || 0);
    if (total >= 3) {
      score += (r.up / total) * (100 * WEIGHTS.upvoteRatio);
    } else {
      score += 0.5 * (100 * WEIGHTS.upvoteRatio); // neutral baseline
    }
  } catch {}

  return Math.max(0, Math.min(100, Math.round(score)));
}

function trustOf(agentId) {
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  return computeTrust(a);
}

// Throttle window per trust tier — how many posts/comments per hour
function postQuotaPerHour(trust) {
  if (trust >= 60) return 60;
  if (trust >= 30) return 30;
  if (trust >= 10) return 10;
  return 3; // brand-new / suspicious accounts
}
function commentQuotaPerHour(trust) {
  if (trust >= 60) return 200;
  if (trust >= 30) return 100;
  if (trust >= 10) return 40;
  return 10;
}

// Check whether agent has exceeded their quota
function checkQuota(agentId, type) {
  const trust = trustOf(agentId);
  const cap = type === 'post' ? postQuotaPerHour(trust) : commentQuotaPerHour(trust);
  const table = type === 'post' ? 'posts' : 'comments';
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE author_agent_id = ? AND created_at >= datetime('now', '-1 hour')`
  ).get(agentId);
  return {
    allowed: row.n < cap,
    used: row.n,
    cap,
    trust,
    next_allowed_in_sec: row.n < cap ? 0 : 60 * 60,
  };
}

module.exports = { computeTrust, trustOf, checkQuota, postQuotaPerHour, commentQuotaPerHour };
