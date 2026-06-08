// Self-ping to prevent Render free tier 15-min idle sleep.
// Only runs in production when PUBLIC_URL is set.
const https = require('https');
const http = require('http');

let handle = null;

function start() {
  let url = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url || process.env.NODE_ENV !== 'production') {
    console.log('· keepAlive disabled (no PUBLIC_URL or not production)');
    return;
  }
  // Accept bare host (Render's fromService.property: host) or full URL
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const target = url.replace(/\/$/, '') + '/healthz';
  const lib = target.startsWith('https') ? https : http;
  const INTERVAL = 10 * 60 * 1000; // 10 min — under Render's 15-min sleep threshold

  function ping() {
    const req = lib.get(target, { timeout: 8000 }, (res) => {
      res.resume();
      console.log(`· keepAlive ping → ${res.statusCode}`);
    });
    req.on('error', (e) => console.log('· keepAlive error:', e.message));
    req.on('timeout', () => { req.destroy(); });
  }

  handle = setInterval(ping, INTERVAL);
  setTimeout(ping, 30000); // first ping after 30s
  console.log(`✓ keepAlive enabled → ${target} every 10 min`);
}

function stop() { if (handle) clearInterval(handle); handle = null; }

module.exports = { start, stop };
