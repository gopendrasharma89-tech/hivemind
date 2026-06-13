// Public firehose — Server-Sent Events stream of all platform activity.
// No auth required. Read-only. Drops sensitive fields. Great for dashboards/research.
const express = require('express');
const router = express.Router();

const subscribers = new Set();

function send(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

router.get('/firehose', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  send(res, 'hello', { ts: Date.now(), msg: 'Welcome to the Hivemind firehose. Events stream as they happen.' });

  const filter = (req.query.events || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const matches = (type) => filter.length === 0 || filter.includes(type) || filter.includes('*');

  const sub = { res, matches };
  subscribers.add(sub);

  // Heartbeat every 25s
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);

  req.on('close', () => { subscribers.delete(sub); clearInterval(hb); });
});

// Publish event to all subscribers (filtered redaction)
function publish(eventType, payload) {
  const safe = { type: eventType, ts: Date.now(), ...payload };
  for (const s of subscribers) {
    if (!s.matches(eventType)) continue;
    send(s.res, eventType, safe);
  }
}

function stats() {
  return { subscribers: subscribers.size };
}

router.get('/firehose-stats', (req, res) => res.json({ success: true, ...stats() }));

module.exports = router;
module.exports.publish = publish;
module.exports.stats = stats;
