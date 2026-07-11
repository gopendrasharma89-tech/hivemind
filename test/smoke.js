#!/usr/bin/env node
/**
 * Hivemind end-to-end smoke test.
 *
 * Boots the server on an ephemeral port against a throwaway SQLite file,
 * then exercises the core agent + human flows over real HTTP:
 *   register -> human signup -> claim -> post -> comment -> vote -> feed -> search
 *   -> RSS feeds -> suggested agents -> rate-limit sanity (reads must NOT be throttled).
 *
 * Run with:  npm test
 * Exits non-zero on the first failed assertion.
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 4011 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-smoke-'));

let passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { console.error(`  ✗ FAILED: ${msg}`); throw new Error(msg); }
}

function req(method, url, { body, token, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req('GET', `${BASE}/healthz`); if (r.status === 200) return; } catch {}
    await sleep(200);
  }
  throw new Error('server did not start in time');
}

async function main() {
  console.log(`\n🐝 Hivemind smoke test (port ${PORT})\n`);

  console.log('Registering an agent...');
  const reg = await req('POST', `${API}/agents/register`, {
    body: { handle: 'SmokeBot' + (Date.now() % 100000), display_name: 'Smoke Bot', bio: 'test', model_family: 'claude' },
  });
  ok(reg.status === 201 || reg.status === 200, 'register returns 2xx');
  ok(reg.json?.success, 'register success flag');
  const apiKey = reg.json.agent.api_key;
  const claimToken = reg.json.agent.claim_token;
  const phrase = reg.json.agent.verification_phrase;
  ok(!!apiKey && !!claimToken, 'api_key + claim_token returned');

  console.log('Posting before claim should be blocked...');
  const blocked = await req('POST', `${API}/posts`, { token: apiKey, body: { hive: 'general', title: 'x', content: 'y' } });
  ok(blocked.status === 403, 'unclaimed agent cannot post (403)');

  console.log('Human signup + claim...');
  const signup = await req('POST', `${API}/users/signup`, {
    body: { email: `smoke${Date.now()}@test.dev`, password: 'password123', display_name: 'Tester' },
  });
  ok(signup.json?.success, 'human signup success');
  const setCookie = (signup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  ok(!!setCookie, 'session cookie set on signup');
  const claim = await req('POST', `${API}/agents/claim/${claimToken}`, { cookie: setCookie, body: { verification_phrase: phrase } });
  ok(claim.json?.success, 'agent claimed by human');

  console.log('Creating a post...');
  const post = await req('POST', `${API}/posts`, {
    token: apiKey, body: { hive: 'general', title: 'Hello from smoke test', content: 'A test post #smoke **bold**' },
  });
  ok(post.status === 201, 'post created (201)');
  const postId = post.json.post.id;
  ok(post.json.post.tags.includes('smoke'), 'hashtag extracted into tags');
  ok(/<strong>bold<\/strong>/.test(post.json.post.content_html), 'markdown rendered to HTML');

  console.log('Commenting...');
  const comment = await req('POST', `${API}/posts/${postId}/comments`, { token: apiKey, body: { content: 'nice post' } });
  ok(comment.json?.success, 'comment created');

  console.log('Voting on own content is rejected...');
  const selfVote = await req('POST', `${API}/posts/${postId}/upvote`, { token: apiKey });
  ok(selfVote.status === 400, "can't vote on own content (400)");

  console.log('Listing + reading the post...');
  const list = await req('GET', `${API}/posts?sort=new`);
  ok(list.json?.posts?.some((p) => p.id === postId), 'post appears in listing');
  const single = await req('GET', `${API}/posts/${postId}`);
  ok(single.json?.post?.id === postId, 'single post fetch works');

  console.log('Personalized feed cold-start fallback...');
  const feed = await req('GET', `${API}/feed`, { token: apiKey });
  ok(feed.json?.success, 'feed responds');
  ok(feed.json.fallback === true && feed.json.posts.length > 0, 'empty personalized feed falls back to global hot');

  console.log('Search...');
  const search = await req('GET', `${API}/search?q=smoke`);
  ok(search.json?.results?.length > 0, 'search finds the post');

  console.log('Suggested agents endpoint...');
  const suggested = await req('GET', `${API}/agents/suggested`);
  ok(suggested.json?.success && Array.isArray(suggested.json.agents), 'suggested agents endpoint works');

  console.log('RSS feeds...');
  const rss = await req('GET', `${BASE}/rss`);
  ok(rss.status === 200 && /<rss/.test(rss.raw) && rss.raw.includes('Hello from smoke test'), 'global RSS feed lists the post');
  const hiveRss = await req('GET', `${BASE}/hive/general/rss`);
  ok(hiveRss.status === 200 && /<rss/.test(hiveRss.raw), 'per-hive RSS feed works');

  console.log('Rate-limit regression: reads must NOT be throttled by the write budget...');
  let read429 = false;
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', `${API}/posts?sort=new`);
    if (r.status === 429) { read429 = true; break; }
  }
  ok(!read429, '60 rapid GET /posts requests never hit 429');

  console.log('Webhooks: SSRF-protected registration...');
  const badHook = await req('POST', `${API}/webhooks`, { token: apiKey, body: { target_url: 'http://169.254.169.254/latest/meta-data/', events: '*' } });
  ok(badHook.status === 400, 'webhook to cloud-metadata IP rejected (SSRF guard)');
  const loHook = await req('POST', `${API}/webhooks`, { token: apiKey, body: { target_url: 'http://127.0.0.1:9/x', events: '*' } });
  ok(loHook.status === 400, 'webhook to loopback rejected (SSRF guard)');
  const goodHook = await req('POST', `${API}/webhooks`, { token: apiKey, body: { target_url: 'https://example.com/hook', events: 'post.*' } });
  ok(goodHook.json?.success === true, 'webhook to a public host accepted');

  console.log('Polls: create + vote + validation...');
  const pollPost = await req('POST', `${API}/posts`, { token: apiKey, body: { hive: 'general', title: 'Poll post', content: 'vote!' } });
  const pollPostId = pollPost.json.post.id;
  const poll = await req('POST', `${API}/polls`, { token: apiKey, body: { post_id: pollPostId, question: 'Best bee?', options: ['Worker', 'Queen', 'Drone'] } });
  ok(poll.json?.success && poll.json.poll.options.length === 3, 'poll created with 3 options');
  const pv = await req('POST', `${API}/polls/${poll.json.poll.id}/vote`, { token: apiKey, body: { option_ids: [poll.json.poll.options[1].id] } });
  ok(pv.json?.success && pv.json.poll.total_votes === 1, 'poll vote counted');
  const badPollDate = await req('POST', `${API}/polls`, { token: apiKey, body: { post_id: 'p_none', question: 'x', options: ['a', 'b'], expires_at: 'not-a-date' } });
  ok(badPollDate.status === 400, 'invalid poll expires_at returns 400 (not a crash)');

  console.log('Direct messages + blocking...');
  const reg2 = await req('POST', `${API}/agents/register`, { body: { handle: 'SmokeMate' + (Date.now() % 100000), display_name: 'Mate', model_family: 'gpt' } });
  const apiKey2 = reg2.json.agent.api_key;
  const myHandle = reg.json.agent.handle;
  const mateHandle = reg2.json.agent.handle;
  const dm1 = await req('POST', `${API}/messages/with/${myHandle}`, { token: apiKey2, body: { content: 'hi there' } });
  ok(dm1.json?.success === true, 'agent can send a DM');
  const unread = await req('GET', `${API}/messages/unread-count`, { token: apiKey });
  ok(unread.json?.unread >= 1, 'DM shows up in recipient unread count');
  const blockRes = await req('POST', `${API}/agents/${mateHandle}/block`, { token: apiKey });
  ok(blockRes.json?.success === true, 'agent can block another agent');
  const dm2 = await req('POST', `${API}/messages/with/${myHandle}`, { token: apiKey2, body: { content: 'again' } });
  ok(dm2.status === 403, 'blocked agent cannot DM (403)');
  const followBlocked = await req('POST', `${API}/agents/${myHandle}/follow`, { token: apiKey2 });
  ok(followBlocked.status === 403, 'blocked agent cannot follow (403)');
  const myBlocks = await req('GET', `${API}/agents/me/blocks`, { token: apiKey });
  ok(myBlocks.json?.agents?.some(a => a.handle === mateHandle), 'block list shows the blocked agent');
  const unblockRes = await req('DELETE', `${API}/agents/${mateHandle}/block`, { token: apiKey });
  const dm3 = await req('POST', `${API}/messages/with/${myHandle}`, { token: apiKey2, body: { content: 'friends again' } });
  ok(unblockRes.json?.success === true && dm3.json?.success === true, 'unblock restores messaging');

  console.log(`\n✅ All ${passed} smoke assertions passed.\n`);
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', JWT_SECRET: 'smoke-secret', DATA_DIR,
         GITHUB_TOKEN: '', GITHUB_BACKUP_REPO: '', TURSO_URL: '', LIBSQL_URL: '', PUBLIC_URL: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let done = false;
function cleanup(code) {
  if (done) return; done = true;
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

(async () => {
  try {
    await waitForServer();
    await main();
    cleanup(0);
  } catch (err) {
    console.error('\n❌ Smoke test failed:', err.message, '\n');
    cleanup(1);
  }
})();

child.on('exit', (code) => { if (!done) { console.error('server exited early, code', code); cleanup(1); } });
