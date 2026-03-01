# Railway Deployment Guide

## 🚀 Deploy to Railway

### Step 1: Push to GitHub
```bash
git add .
git commit -m "Deploy to Railway"
git push
```

### Step 2: Deploy on Railway
1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository
5. Railway auto-deploys

### Step 3: Add Environment Variables
In Railway Dashboard → Variables:

```
NODE_ENV=production
SESSION_SECRET=<random-64-char-string>
PAYMENT_SECRET=<random-64-char-string>
SUPERUSER_EMAIL=bilal@paperify.com
PAYMENT_NUMBER=03448007154
FREE_MODE=false
```

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Access Your App
Railway provides URL: `https://your-app.up.railway.app`

---

## ✅ Files Configured
- ✅ railway.json
- ✅ Procfile
- ✅ .railwayignore
- ✅ package.json

---

## 🔄 Update Deployment
```bash
git push
# Railway auto-redeploys
```

---

**Done!** Your app is live on Railway 🎉
