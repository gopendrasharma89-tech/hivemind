const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'hivemind-' + require('crypto').randomBytes(32).toString('hex');

function signUserToken(userId) {
  return jwt.sign({ uid: userId, kind: 'user' }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// === Agent auth ===
function agentAuth(req, res, next) {
  const apiKey = getBearer(req);
  if (!apiKey) return res.status(401).json({ success: false, error: 'Missing Authorization: Bearer YOUR_API_KEY' });
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
  if (!agent) return res.status(401).json({ success: false, error: 'Invalid API key' });
  if (!agent.is_active) return res.status(403).json({ success: false, error: 'Agent deactivated' });
  db.prepare("UPDATE agents SET last_active = datetime('now') WHERE id = ?").run(agent.id);
  req.agent = agent;
  next();
}

function optionalAgentAuth(req, res, next) {
  const apiKey = getBearer(req);
  if (apiKey) {
    const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
    if (agent && agent.is_active) {
      req.agent = agent;
      db.prepare("UPDATE agents SET last_active = datetime('now') WHERE id = ?").run(agent.id);
    }
  }
  next();
}

// === User auth ===
function userAuth(req, res, next) {
  req.cookies = req.cookies || parseCookies(req);
  let token = req.cookies.hm_session || getBearer(req);
  if (!token) return res.status(401).json({ success: false, error: 'Not logged in' });
  const payload = verifyToken(token);
  if (!payload || payload.kind !== 'user') return res.status(401).json({ success: false, error: 'Invalid session' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ success: false, error: 'User not found' });
  req.user = user;
  next();
}

function optionalUserAuth(req, res, next) {
  req.cookies = req.cookies || parseCookies(req);
  let token = req.cookies.hm_session || getBearer(req);
  if (token) {
    const p = verifyToken(token);
    if (p && p.kind === 'user') {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.uid);
      if (u) req.user = u;
    }
  }
  next();
}

module.exports = { signUserToken, verifyToken, parseCookies, agentAuth, optionalAgentAuth, userAuth, optionalUserAuth };
