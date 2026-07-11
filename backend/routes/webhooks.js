// Webhook CRUD + delivery log for agents.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { agentAuth } = require('../auth');
const { assertSafeUrl } = require('../ssrfGuard');
const { ALLOWED_EVENTS, sign } = require('../webhooks');

const router = express.Router();

function publicHook(h, includeSecret = false) {
  if (!h) return null;
  const out = {
    id: h.id,
    target_url: h.target_url,
    events: h.events,
    is_active: !!h.is_active,
    last_status: h.last_status,
    last_delivery_at: h.last_delivery_at,
    failure_count: h.failure_count,
    created_at: h.created_at,
  };
  if (includeSecret) out.secret = h.secret;
  return out;
}

// GET /webhooks — list my hooks
router.get('/', agentAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM webhooks WHERE agent_id = ? ORDER BY created_at DESC').all(req.agent.id);
  res.json({ success: true, webhooks: rows.map(r => publicHook(r)), allowed_events: ALLOWED_EVENTS });
});

// POST /webhooks — create a webhook
router.post('/', agentAuth, async (req, res) => {
  const target = (req.body.target_url || '').toString().trim().slice(0, 500);
  const events = (req.body.events || '*').toString().trim().slice(0, 200);
  if (!/^https?:\/\/[\w.-]+/.test(target)) return res.status(400).json({ success: false, error: 'target_url must be http(s)://...' });
  const safe = await assertSafeUrl(target);
  if (!safe.ok) return res.status(400).json({ success: false, error: safe.error });

  const count = db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE agent_id = ?').get(req.agent.id).n;
  if (count >= 5) return res.status(400).json({ success: false, error: 'Max 5 webhooks per agent' });

  const id = 'wh_' + crypto.randomBytes(8).toString('hex');
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO webhooks (id, agent_id, target_url, secret, events) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.agent.id, target, secret, events);

  const fresh = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  res.json({ success: true, webhook: publicHook(fresh, true) });
});

// PATCH /webhooks/:id — update events / target / active
router.patch('/:id', agentAuth, async (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!h || h.agent_id !== req.agent.id) return res.status(404).json({ success: false, error: 'Not found' });
  const updates = []; const values = [];
  if (req.body.target_url !== undefined) {
    const t = (req.body.target_url || '').toString().trim();
    if (!/^https?:\/\//.test(t)) return res.status(400).json({ success: false, error: 'Invalid target_url' });
    const safe = await assertSafeUrl(t);
    if (!safe.ok) return res.status(400).json({ success: false, error: safe.error });
    updates.push('target_url = ?'); values.push(t.slice(0, 500));
  }
  if (req.body.events !== undefined) { updates.push('events = ?'); values.push((req.body.events || '*').toString().slice(0, 200)); }
  if (req.body.is_active !== undefined) { updates.push('is_active = ?'); values.push(req.body.is_active ? 1 : 0); if (req.body.is_active) updates.push('failure_count = 0'); }
  if (!updates.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

// DELETE /webhooks/:id
router.delete('/:id', agentAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!h || h.agent_id !== req.agent.id) return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /webhooks/:id/deliveries — recent delivery log
router.get('/:id/deliveries', agentAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!h || h.agent_id !== req.agent.id) return res.status(404).json({ success: false, error: 'Not found' });
  const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT 30').all(req.params.id);
  res.json({ success: true, deliveries: rows });
});

// POST /webhooks/:id/test — send a ping event
router.post('/:id/test', agentAuth, async (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!h || h.agent_id !== req.agent.id) return res.status(404).json({ success: false, error: 'Not found' });
  const { trigger } = require('../webhooks');
  trigger(req.agent.id, 'webhook.test', { hello: 'world', handle: req.agent.handle, ts: Date.now() });
  res.json({ success: true, message: 'Test dispatched. Check deliveries in a few seconds.' });
});

module.exports = router;
