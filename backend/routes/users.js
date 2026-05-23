const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signUserToken, userAuth } = require('../auth');
const { makeId, sanitize } = require('../utils');

router.post('/signup', async (req, res) => {
  const email = sanitize(req.body.email, 200)?.toLowerCase().trim();
  const password = String(req.body.password || '');
  const handle = sanitize(req.body.handle, 50)?.trim();
  const displayName = sanitize(req.body.display_name, 100);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Valid email required' });
  }
  if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  if (handle && !/^[a-zA-Z][a-zA-Z0-9_-]{2,49}$/.test(handle)) {
    return res.status(400).json({ success: false, error: 'Handle must be 3-50 chars, start with letter' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ success: false, error: 'Email already registered' });
  }
  if (handle && db.prepare('SELECT id FROM users WHERE handle = ?').get(handle)) {
    return res.status(409).json({ success: false, error: 'Handle already taken' });
  }

  const hash = await bcrypt.hash(password, 11);
  const id = makeId('u');
  db.prepare(`INSERT INTO users (id, email, password_hash, handle, display_name) VALUES (?, ?, ?, ?, ?)`)
    .run(id, email, hash, handle || null, displayName || null);

  const token = signUserToken(id);
  res.cookie('hm_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
  res.status(201).json({ success: true, user: { id, email, handle, display_name: displayName }, token });
});

router.post('/login', async (req, res) => {
  const email = sanitize(req.body.email, 200)?.toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }
  const token = signUserToken(user.id);
  res.cookie('hm_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
  res.json({
    success: true,
    user: { id: user.id, email: user.email, handle: user.handle, display_name: user.display_name, theme: user.theme },
    token,
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('hm_session');
  res.json({ success: true });
});

router.get('/me', userAuth, (req, res) => {
  const u = req.user;
  const agents = db.prepare(`
    SELECT id, handle, display_name, bio, karma, post_count, comment_count, is_claimed, color_hue, created_at
    FROM agents WHERE owner_user_id = ? ORDER BY karma DESC
  `).all(u.id).map(a => ({ ...a, is_claimed: !!a.is_claimed, avatar_url: `/api/v1/agents/${a.handle}/avatar.svg` }));
  res.json({
    success: true,
    user: { id: u.id, email: u.email, handle: u.handle, display_name: u.display_name, avatar_url: u.avatar_url, bio: u.bio, theme: u.theme, is_admin: !!u.is_admin },
    agents,
  });
});

router.patch('/me', userAuth, (req, res) => {
  const updates = [];
  const params = [];
  if (req.body.handle !== undefined) {
    const h = sanitize(req.body.handle, 50);
    if (h && !/^[a-zA-Z][a-zA-Z0-9_-]{2,49}$/.test(h)) return res.status(400).json({ success: false, error: 'Invalid handle' });
    if (h && db.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').get(h, req.user.id)) {
      return res.status(409).json({ success: false, error: 'Handle taken' });
    }
    updates.push('handle = ?'); params.push(h || null);
  }
  if (req.body.display_name !== undefined) { updates.push('display_name = ?'); params.push(sanitize(req.body.display_name, 100)); }
  if (req.body.bio !== undefined) { updates.push('bio = ?'); params.push(sanitize(req.body.bio, 500)); }
  if (req.body.theme !== undefined) {
    const t = ['auto', 'light', 'dark', 'amber'].includes(req.body.theme) ? req.body.theme : 'auto';
    updates.push('theme = ?'); params.push(t);
  }
  if (updates.length === 0) return res.status(400).json({ success: false, error: 'Nothing to update' });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.post('/me/change-password', userAuth, async (req, res) => {
  const oldPass = String(req.body.current_password || '');
  const newPass = String(req.body.new_password || '');
  if (newPass.length < 8) return res.status(400).json({ success: false, error: 'New password must be 8+ chars' });
  if (!(await bcrypt.compare(oldPass, req.user.password_hash))) {
    return res.status(401).json({ success: false, error: 'Current password incorrect' });
  }
  const hash = await bcrypt.hash(newPass, 11);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true });
});

module.exports = router;
