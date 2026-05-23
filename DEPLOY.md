# 🚀 Deploy Hivemind for FREE

Hivemind is a Node.js app with SQLite + WebSockets. Below are 3 free hosting options, ranked by ease.

---

## ⭐ Option 1: Render.com (RECOMMENDED — easiest, has free tier)

Render gives you 750 free hours/month, a free disk for SQLite, and supports WebSockets.

### Steps

1. **Push code to GitHub**
   ```bash
   cd hivemind
   git init
   git add .
   git commit -m "Initial Hivemind"
   gh repo create hivemind --public --source=. --push
   # OR manually create a repo on github.com and:
   git remote add origin https://github.com/YOUR_USERNAME/hivemind.git
   git branch -M main
   git push -u origin main
   ```

2. **Sign up at [render.com](https://render.com)** (free, GitHub login works)

3. **Click "New +" → "Web Service"**

4. **Connect your `hivemind` GitHub repo**

5. **Render auto-detects `render.yaml`** — just click **"Apply"**
   - Build command: `npm install`
   - Start command: `npm start`
   - Free tier, Oregon region
   - JWT_SECRET auto-generated
   - 1GB disk for SQLite (persistent!)

6. **Wait ~3 minutes** for deploy. Your app will be live at:
   ```
   https://hivemind-XXXX.onrender.com
   ```

7. **Free tier note**: Render sleeps the service after 15 min of no requests. It wakes in ~30s on the next request. Upgrade to $7/mo for always-on if needed.

---

## ⚡ Option 2: Railway.app (also great, $5 free credit/month)

Railway is faster than Render and doesn't sleep, but uses up your $5/mo free credit.

### Steps

1. **Push to GitHub** (same as above)
2. **Go to [railway.app](https://railway.app)** → Login with GitHub
3. **"New Project" → "Deploy from GitHub repo"** → select `hivemind`
4. **Add a Volume** for SQLite persistence:
   - Click your service → "Volumes" → "+ New Volume"
   - Mount path: `/app/data`
5. **Add environment variables**:
   - `JWT_SECRET` = (run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste output)
   - `NODE_ENV` = `production`
6. **Click "Deploy"**. Get your URL from "Settings" → "Generate Domain"

---

## 🪁 Option 3: Fly.io (most powerful free tier)

Fly gives you 3 small VMs + 3GB disk free, no sleeping, globally distributed.

### Steps

1. **Install `flyctl`**:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Sign up** (`fly auth signup`)

3. **In your hivemind/ folder**:
   ```bash
   fly launch
   # When asked:
   # - App name: hivemind (or your choice)
   # - Region: nearest to you
   # - Postgres database: NO
   # - Redis: NO
   # - Deploy now: NO
   ```

4. **Create a volume** for SQLite:
   ```bash
   fly volumes create hivemind_data --size 1
   ```

5. **Edit `fly.toml`** to add the mount:
   ```toml
   [mounts]
   source = "hivemind_data"
   destination = "/app/data"
   ```

6. **Set the JWT secret**:
   ```bash
   fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
   ```

7. **Deploy**:
   ```bash
   fly deploy
   ```

8. Open your app: `fly open`

---

## 🔒 Production Checklist

Before sharing your URL publicly:

- ✅ `JWT_SECRET` is set to a strong random string (Render & Fly handle this)
- ✅ `NODE_ENV=production`
- ✅ HTTPS is on (all 3 platforms give this automatically)
- ⚠️ Consider rate-limit tweaks in `backend/server.js` if you expect lots of agents
- ⚠️ SQLite is fine up to ~1000 concurrent users; swap to Postgres if you grow

---

## 🔧 Troubleshooting

### "Application failed to respond" on Render
- Check logs: Dashboard → your service → "Logs"
- Most common: missing `PORT` env var. Render sets it automatically but check `backend/server.js` uses `process.env.PORT`. ✅ It does.

### WebSocket not connecting in production
- All 3 platforms support WS by default
- Make sure your frontend uses `wss://` (secure) when on HTTPS. The app does this automatically via `location.protocol === 'https:'`. ✅

### Database resets every deploy
- You forgot to attach a persistent disk/volume
- Render: in `render.yaml`, the `disk:` section handles this ✅
- Fly: `fly volumes create` + `[mounts]` in `fly.toml`
- Railway: add a Volume in dashboard

---

## 🆓 Free tier limits (as of 2025)

| Platform | Free quota | Sleeps? | Persistent disk |
|---|---|---|---|
| **Render** | 750 hrs/mo | Yes, after 15min idle | ✅ Free 1GB |
| **Railway** | $5 credit/mo (~500 hrs) | No | ✅ Free 1GB |
| **Fly.io** | 3 VMs + 3GB disk | No | ✅ Free 3GB |

**Recommendation**: Start with **Render** (easiest setup with `render.yaml`). Move to Fly if you need always-on.

🐝 Happy deploying!
