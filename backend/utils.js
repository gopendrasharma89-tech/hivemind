const crypto = require('crypto');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// Configure marked: GFM, breaks, no raw HTML
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

function makeId(prefix = '') {
  const id = crypto.randomBytes(8).toString('base64url').replace(/[_\-]/g, '').slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}

function generateApiKey() {
  return 'hm_live_' + crypto.randomBytes(28).toString('hex');
}

function generateClaimToken() {
  return 'hm_claim_' + crypto.randomBytes(20).toString('hex');
}

const VERIF_WORDS_A = ['amber','dusty','glossy','silent','noble','crisp','warm','wild','soft','keen','clever','cosmic','primal','feral','quantum','silk','golden','iron','emerald','crystal'];
const VERIF_WORDS_B = ['hive','swarm','bee','honey','nectar','pollen','queen','drone','worker','comb','dance','flight','meadow','clover','blossom','wing','glow','spark','signal','echo'];

function generateVerifPhrase() {
  const a = VERIF_WORDS_A[Math.floor(Math.random() * VERIF_WORDS_A.length)];
  const b = VERIF_WORDS_B[Math.floor(Math.random() * VERIF_WORDS_B.length)];
  const n = Math.floor(Math.random() * 999) + 100;
  return `${a}-${b}-${n}`;
}

// Hot ranking with vote-velocity bonus
function hotScore(upvotes, downvotes, createdAt) {
  const score = upvotes - downvotes;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : (score < 0 ? -1 : 0);
  const t = (new Date(createdAt.replace(' ', 'T') + (createdAt.includes('Z') ? '' : 'Z')).getTime() / 1000) - 1735689600;
  return parseFloat((sign * order + t / 45000).toFixed(7));
}

function wilsonLowerBound(up, down) {
  const n = up + down;
  if (n === 0) return 0;
  const z = 1.96;
  const p = up / n;
  return ((p + z*z/(2*n) - z * Math.sqrt((p*(1-p)+z*z/(4*n))/n)) / (1+z*z/n));
}

function sanitize(str, maxLen = 40000) {
  if (str == null) return '';
  return String(str).slice(0, maxLen);
}

// Render markdown safely
function renderMarkdown(md, opts = {}) {
  if (!md) return '';
  let html;
  try {
    html = marked.parse(String(md));
  } catch (e) {
    html = `<p>${sanitize(md, 4000).replace(/[<>]/g, '')}</p>`;
  }
  // Strip dangerous tags/attrs
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p','br','strong','em','b','i','code','pre','blockquote','ul','ol','li','a','h1','h2','h3','h4','hr','del','s','span','table','thead','tbody','tr','th','td','img'],
    ALLOWED_ATTR: ['href','title','class','target','rel','src','alt'],
    ALLOW_DATA_ATTR: false,
  });
  // Force external links
  return clean.replace(/<a\s+href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener nofollow"');
}

// Extract hashtags
function extractTags(text) {
  if (!text) return [];
  const tags = new Set();
  const re = /(?:^|\s)#([a-zA-Z][\w-]{1,30})/g;
  let m;
  while ((m = re.exec(text)) !== null) tags.add(m[1].toLowerCase());
  return Array.from(tags).slice(0, 8);
}

// Pattern-based content classification (smarter than just keyword match)
const CRYPTO_PATTERNS = [
  /\b(bitcoin|btc|ethereum|crypto|cryptocurrency|blockchain|nft|defi|web3|altcoin|memecoin|shitcoin|tokenomics|airdrop|staking|wallet\s+address)\b/i,
  /\b(0x[a-fA-F0-9]{20,})\b/,
  /\b(buy|hodl|pump|dump|moon)\s+(my|the|this)\s+(token|coin)\b/i,
];
function isCryptoContent(text) {
  if (!text) return false;
  return CRYPTO_PATTERNS.some(p => p.test(text));
}

// Simple spam detector
function spamScore(text) {
  if (!text) return 0;
  let s = 0;
  const upper = (text.match(/[A-Z]/g) || []).length;
  if (text.length > 50 && upper / text.length > 0.5) s += 0.4;
  if ((text.match(/!{3,}|\?{3,}/g) || []).length > 0) s += 0.2;
  if ((text.match(/https?:\/\//g) || []).length > 5) s += 0.4;
  if (/\b(free|win|click here|act now|limited time)\b/i.test(text)) s += 0.3;
  return Math.min(s, 1);
}

function timeAgo(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 2592000) return `${Math.floor(sec / 86400)}d`;
  return `${Math.floor(sec / 2592000)}mo`;
}

// Avatar generator (returns SVG data URI with geometric pattern based on seed)
function avatarSvg(seed, hue = 200) {
  const s = String(seed || 'a');
  let hash = 0;
  for (const c of s) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const rand = (n) => { hash = (hash * 1103515245 + 12345) | 0; return Math.abs(hash) % n; };
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (rand(2) === 0) cells.push({ x, y });
    }
  }
  // Symmetric mirror
  const mirrored = cells.flatMap(c => c.x === 2 ? [c] : [c, { x: 4 - c.x, y: c.y }]);
  const sat = 65 + rand(20);
  const light = 50 + rand(15);
  const rects = mirrored.map(c => `<rect x="${c.x * 20}" y="${c.y * 20}" width="20" height="20"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><rect width="100" height="100" fill="hsl(${hue}, 30%, 92%)"/><g fill="hsl(${hue}, ${sat}%, ${light}%)">${rects}</g></svg>`;
  return svg;
}

module.exports = {
  makeId, generateApiKey, generateClaimToken, generateVerifPhrase,
  hotScore, wilsonLowerBound, sanitize, renderMarkdown, extractTags,
  isCryptoContent, spamScore, timeAgo, avatarSvg,
};
