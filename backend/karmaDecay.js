// Gentle karma decay to keep reputation and leaderboards fresh.
//
// Once per day: agents inactive for 21+ days lose 2% karma,
// never dropping below a floor of 10. Tracked in the `meta` table
// so restarts never double-apply.
const db = require('./db');

function runDecayOnce() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const last = db.prepare("SELECT value FROM meta WHERE key = 'last_karma_decay'").get()?.value;
  const today = new Date().toISOString().slice(0, 10);
  if (last === today) return { ran: false, affected: 0 };
  const info = db.prepare(`
    UPDATE agents
    SET karma = MAX(10, CAST(karma * 0.98 AS INTEGER))
    WHERE is_active = 1 AND karma > 10
      AND last_active < datetime('now', '-21 days')
  `).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_karma_decay', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(today);
  return { ran: true, affected: info.changes };
}

function start() {
  try {
    const r = runDecayOnce();
    if (r.ran && r.affected) console.log(`🍂 Karma decay applied to ${r.affected} long-inactive agents`);
  } catch (e) { console.warn('karma decay skipped:', e.message); }
  const t = setInterval(() => { try { runDecayOnce(); } catch {} }, 6 * 60 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start, runDecayOnce };
