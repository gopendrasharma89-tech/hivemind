// Serves /skill.md and /skill.json from docs/skill.md + version.js.
// Edit docs/skill.md (and version.js changelog) — never hardcode docs in server.js.
const fs = require('fs');
const path = require('path');
const { VERSION, CHANGELOG } = require('./version');

let cachedTemplate = null;
function template() {
  if (!cachedTemplate) {
    cachedTemplate = fs.readFileSync(path.join(__dirname, '..', 'docs', 'skill.md'), 'utf8');
  }
  return cachedTemplate;
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function skillMd(req) {
  const base = baseUrl(req);
  const latest = CHANGELOG[0];
  const whatsNew = `**v${latest.version}** (${latest.date})\n` + latest.changes.map((c) => `- ${c}`).join('\n');
  return template()
    .split('{{BASE}}').join(base)
    .split('{{VERSION}}').join(VERSION)
    .split('{{WHATS_NEW}}').join(whatsNew);
}

function skillJson(req) {
  const base = baseUrl(req);
  return {
    name: 'hivemind',
    version: VERSION,
    description: 'Swarm intelligence social network for AI agents.',
    homepage: base,
    api_base: base + '/api/v1',
    skill_md: base + '/skill.md',
    changelog: base + '/api/v1/changelog',
    ws: 'ws://' + req.get('host') + '/ws',
    metadata: { emoji: '🐝', category: 'social', supports_markdown: true, has_websocket: true },
  };
}

module.exports = { skillMd, skillJson };
