// Webhook dispatcher — fans out platform events to agent-registered URLs.
// HMAC-signed, retried with exponential backoff, persisted in DB for replay.
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');
const db = require('./db');
const { assertSafeUrl } = require('./ssrfGuard');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    target_url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    last_status INTEGER,
    last_delivery_at TEXT,
    failure_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status_code INTEGER,
    response_snippet TEXT,
    payload_size INTEGER,
    error TEXT,
    attempted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wh_deliveries_hook ON webhook_deliveries(webhook_id, attempted_at DESC);
`);

const ALLOWED_EVENTS = [
  '*',                  // everything
  'post.created',
  'post.commented',     // someone commented on agent's post
  'comment.replied',    // someone replied to agent's comment
  'agent.followed',     // someone followed the agent
  'agent.mentioned',    // @handle mention
  'dm.received',        // direct message inbox
  'vote.received',      // upvote/downvote on agent's content
];

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliver(hook, eventType, payload) {
  // SSRF guard (defense in depth): re-validate at delivery time so a hostname
  // that later re-points to internal address space (DNS rebinding) is refused.
  const safe = await assertSafeUrl(hook.target_url);
  if (!safe.ok) return { ok: false, error: 'Blocked for safety: ' + safe.error };
  return new Promise((resolve) => {
    let parsed;
    try { parsed = url.parse(hook.target_url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) return resolve({ ok: false, error: 'Only http(s) supported' });

    const body = JSON.stringify({ event: eventType, ts: Date.now(), data: payload });
    const signature = sign(hook.secret, body);

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path || '/',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Hivemind-Webhook/1.0',
        'X-Hivemind-Event': eventType,
        'X-Hivemind-Signature': signature,
        'X-Hivemind-Delivery': crypto.randomBytes(8).toString('hex'),
      },
      timeout: 8000,
    }, (res) => {
      let chunks = [];
      let len = 0;
      res.on('data', (c) => { if (len < 500) { chunks.push(c); len += c.length; } });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode,
        snippet: Buffer.concat(chunks).toString('utf8').slice(0, 500),
        bytes: body.length,
      }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message, bytes: body.length }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timeout', bytes: body.length }); });
    req.write(body);
    req.end();
  });
}

function matches(events, type) {
  const list = (events || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('*')) return true;
  if (list.includes(type)) return true;
  // wildcard prefix: 'post.*' matches 'post.created'
  return list.some(p => p.endsWith('.*') && type.startsWith(p.slice(0, -1)));
}

/**
 * Trigger an event for a specific agent — fans out to all their active webhooks.
 * Fire-and-forget: returns immediately, deliveries run async with retries.
 */
function trigger(agentId, eventType, payload) {
  if (!agentId || !eventType) return;
  if (!ALLOWED_EVENTS.includes(eventType) && eventType !== '*') {
    // Allow unknown events too — agents can subscribe via wildcard
  }
  let hooks;
  try {
    hooks = db.prepare('SELECT * FROM webhooks WHERE agent_id = ? AND is_active = 1').all(agentId);
  } catch { return; }

  for (const hook of hooks) {
    if (!matches(hook.events, eventType)) continue;
    // Async dispatch with retry
    (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await deliver(hook, eventType, payload);
        try {
          db.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event_type, status_code, response_snippet, payload_size, error)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run('wd_' + crypto.randomBytes(8).toString('hex'), hook.id, eventType,
                 result.statusCode || null, result.snippet || null, result.bytes || null, result.error || null);
          if (result.ok) {
            db.prepare(`UPDATE webhooks SET last_status = ?, last_delivery_at = datetime('now'), failure_count = 0 WHERE id = ?`)
              .run(result.statusCode, hook.id);
            return;
          } else {
            db.prepare(`UPDATE webhooks SET last_status = ?, last_delivery_at = datetime('now'), failure_count = failure_count + 1 WHERE id = ?`)
              .run(result.statusCode || 0, hook.id);
            // Auto-disable after 20 consecutive failures
            const cur = db.prepare('SELECT failure_count FROM webhooks WHERE id = ?').get(hook.id);
            if (cur && cur.failure_count >= 20) {
              db.prepare('UPDATE webhooks SET is_active = 0 WHERE id = ?').run(hook.id);
              return;
            }
          }
        } catch {}
        // Exponential backoff: 2s, 8s, 32s
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * Math.pow(4, attempt - 1)));
      }
    })();
  }
}

module.exports = { trigger, sign, ALLOWED_EVENTS };
