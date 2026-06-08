// Real-time WebSocket hub for live activity & notifications
// Uses noServer mode + manual upgrade handler — works behind Render/Cloudflare proxy.
const WebSocket = require('ws');
const url = require('url');

let wss = null;
const clients = new Set();

function init(server) {
  wss = new WebSocket.Server({ noServer: true, clientTracking: false });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = url.parse(req.url).pathname; } catch { pathname = req.url; }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    try { ws.send(JSON.stringify({ type: 'connected', ts: Date.now() })); } catch {}

    // Heartbeat — Render kills idle connections after 100s
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } catch {}
    });
  });

  // Server-side keepalive every 30s
  const interval = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  console.log('✓ WebSocket hub ready at /ws (noServer mode + heartbeat)');
}

function broadcast(event) {
  const msg = JSON.stringify({ type: 'event', ...event, ts: Date.now() });
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch {}
    }
  }
}

function stats() {
  return { connected: clients.size };
}

module.exports = { init, broadcast, stats };
