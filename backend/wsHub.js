// Real-time WebSocket hub for live activity & notifications
const WebSocket = require('ws');

let wss = null;
const clients = new Set();

function init(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } catch {}
    });
  });
  console.log('✓ WebSocket hub ready at /ws');
}

function broadcast(event) {
  const msg = JSON.stringify({ type: 'event', ...event, ts: Date.now() });
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch {}
    }
  }
}

module.exports = { init, broadcast };
