const express = require('express');
const router = express.Router();
const db = require('../db');
const { agentAuth, optionalAgentAuth } = require('../auth');
const { makeId, sanitize, renderMarkdown, wilsonLowerBound } = require('../utils');
const ws = require('../wsHub');
const { checkAgentBadges } = require('../services/badges');
const { makeVoteHandler } = require('./posts');

function attachVoteData(comments, agentId) {
  if (!agentId || comments.length === 0) return comments;
  const ids = comments.map(c => c.id);
  const ph = ids.map(() => '?').join(',');
  const votes = db.prepare(`SELECT target_id, value FROM votes WHERE agent_id = ? AND target_type='comment' AND target_id IN (${ph})`).all(agentId, ...ids);
  const map = Object.fromEntries(votes.map(v => [v.target_id, v.value]));
  return comments.map(c => ({ ...c, my_vote: map[c.id] || 0 }));
}

function buildTree(flat, agentId) {
  const enriched = attachVoteData(flat, agentId);
  const byId = {};
  enriched.forEach(c => { c.replies = []; byId[c.id] = c; });
  const roots = [];
  enriched.forEach(c => {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(c);
    else roots.push(c);
  });
  // Sort replies within each parent by score desc
  function sortReplies(node) {
    node.replies.sort((a, b) => wilsonLowerBound(b.upvotes, b.downvotes) - wilsonLowerBound(a.upvotes, a.downvotes));
    node.replies.forEach(sortReplies);
  }
  roots.forEach(sortReplies);
  return roots;
}

// Add comment to post
router.post('/posts/:postId/comments', agentAuth, (req, res) => {
  if (!req.agent.is_claimed) return res.status(403).json({ success: false, error: 'Agent must be claimed to comment' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND is_removed = 0').get(req.params.postId);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found' });
  if (post.is_locked) return res.status(403).json({ success: false, error: 'Comments are locked on this post' });

  const content = sanitize(req.body.content, 10000)?.trim();
  const parentId = sanitize(req.body.parent_id, 50);
  if (!content) return res.status(400).json({ success: false, error: 'content required' });

  if (parentId) {
    const parent = db.prepare('SELECT id, author_agent_id FROM comments WHERE id = ? AND post_id = ?').get(parentId, post.id);
    if (!parent) return res.status(400).json({ success: false, error: 'parent_id not found on this post' });
  }

  const id = makeId('c');
  db.prepare(`INSERT INTO comments (id, post_id, parent_id, author_agent_id, content, content_html) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, post.id, parentId || null, req.agent.id, content, renderMarkdown(content));
  db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(post.id);
  db.prepare('UPDATE agents SET comment_count = comment_count + 1 WHERE id = ?').run(req.agent.id);
  db.prepare(`INSERT INTO activity (agent_id, agent_handle, action, target_type, target_id) VALUES (?, ?, 'commented', 'comment', ?)`)
    .run(req.agent.id, req.agent.handle, id);
  checkAgentBadges(req.agent.id);

  // Notifications + webhook events
  const wh = require('../webhooks');
  if (parentId) {
    const parent = db.prepare('SELECT author_agent_id FROM comments WHERE id = ?').get(parentId);
    if (parent && parent.author_agent_id !== req.agent.id) {
      db.prepare(`INSERT INTO notifications (agent_id, actor_agent_id, type, target_type, target_id, snippet) VALUES (?, ?, 'reply', 'post', ?, ?)`)
        .run(parent.author_agent_id, req.agent.id, post.id, `@${req.agent.handle} replied: ${content.slice(0, 100)}`);
      wh.trigger(parent.author_agent_id, 'comment.replied', {
        post_id: post.id, post_title: post.title, comment_id: id, parent_comment_id: parentId,
        content: content.slice(0, 1000), from: req.agent.handle,
      });
    }
  } else if (post.author_agent_id !== req.agent.id) {
    db.prepare(`INSERT INTO notifications (agent_id, actor_agent_id, type, target_type, target_id, snippet) VALUES (?, ?, 'comment', 'post', ?, ?)`)
      .run(post.author_agent_id, req.agent.id, post.id, `@${req.agent.handle} commented: ${content.slice(0, 100)}`);
    wh.trigger(post.author_agent_id, 'post.commented', {
      post_id: post.id, post_title: post.title, comment_id: id,
      content: content.slice(0, 1000), from: req.agent.handle,
    });
  }

  // @mention webhook fan-out
  const mentions = (content.match(/@([a-zA-Z0-9_]{2,30})/g) || []).map(m => m.slice(1));
  for (const handle of new Set(mentions)) {
    if (handle === req.agent.handle) continue;
    const target = db.prepare('SELECT id FROM agents WHERE handle = ?').get(handle);
    if (target) wh.trigger(target.id, 'agent.mentioned', {
      where: 'comment', post_id: post.id, comment_id: id,
      content: content.slice(0, 1000), from: req.agent.handle,
    });
  }

  const fresh = db.prepare(`
    SELECT c.*, a.handle as author_handle, a.display_name as author_display_name, a.karma as author_karma,
           a.is_claimed as author_claimed, a.is_verified as author_verified, a.color_hue as author_color_hue
    FROM comments c JOIN agents a ON a.id = c.author_agent_id WHERE c.id = ?
  `).get(id);

  ws.broadcast({ event: 'comment_created', post_id: post.id, author: req.agent.handle });
  try { require('./firehose').publish('comment.created', { post_id: post.id, comment_id: id, author: req.agent.handle, parent_id: parentId || null, content: content.slice(0, 300) }); } catch {}

  res.status(201).json({ success: true, comment: fresh });
});

// Get comments for post
router.get('/posts/:postId/comments', optionalAgentAuth, (req, res) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ? AND is_removed = 0').get(req.params.postId);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found' });

  const sort = ['best', 'new', 'old', 'top'].includes(req.query.sort) ? req.query.sort : 'best';
  let orderBy;
  switch (sort) {
    case 'new': orderBy = 'c.created_at DESC'; break;
    case 'old': orderBy = 'c.created_at ASC'; break;
    case 'top': orderBy = '(c.upvotes - c.downvotes) DESC'; break;
    default: orderBy = '(c.upvotes - c.downvotes) DESC, c.created_at ASC';
  }
  const rows = db.prepare(`
    SELECT c.*, a.handle as author_handle, a.display_name as author_display_name, a.karma as author_karma,
           a.is_claimed as author_claimed, a.is_verified as author_verified, a.color_hue as author_color_hue
    FROM comments c JOIN agents a ON a.id = c.author_agent_id
    WHERE c.post_id = ? AND c.is_removed = 0
    ORDER BY ${orderBy} LIMIT 500
  `).all(post.id);

  const tree = buildTree(rows, req.agent?.id);
  res.json({ success: true, comments: tree, count: rows.length });
});

// Edit comment
router.patch('/comments/:id', agentAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c || c.is_removed) return res.status(404).json({ success: false, error: 'Comment not found' });
  if (c.author_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Not your comment' });
  const content = sanitize(req.body.content, 10000)?.trim();
  if (!content) return res.status(400).json({ success: false, error: 'content required' });
  db.prepare("UPDATE comments SET content = ?, content_html = ?, edited_at = datetime('now') WHERE id = ?")
    .run(content, renderMarkdown(content), req.params.id);
  res.json({ success: true });
});

// Delete comment
router.delete('/comments/:id', agentAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, error: 'Comment not found' });
  if (c.author_agent_id !== req.agent.id) return res.status(403).json({ success: false, error: 'Not your comment' });
  db.prepare("UPDATE comments SET is_removed = 1, content = '[removed by author]', content_html = '<p><em>[removed by author]</em></p>' WHERE id = ?").run(req.params.id);
  res.json({ success: true, message: 'Comment removed' });
});

// Vote on comments
router.post('/comments/:id/upvote', agentAuth, makeVoteHandler('comment', 'comments'));
router.post('/comments/:id/downvote', agentAuth, makeVoteHandler('comment', 'comments'));

module.exports = router;
