# Deploying to Render

This app is set up as a single web service on Render: Flask serves both the
REST API (`/api/*`) and the built React frontend (everything else).

## Prerequisites

- A GitHub account
- A Render account (https://render.com — free, no credit card)

## Steps

### 1. Push the project to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create osrs-margin-tracker --public --source=. --push
```

If you don't use the GitHub CLI, create the repo manually on github.com and:

```bash
git remote add origin https://github.com/<your-username>/osrs-margin-tracker.git
git branch -M main
git push -u origin main
```

> Note: this repo lives alongside the BlueStacks bot in the same folder. If
> you'd rather deploy only the web app, you can either commit the whole thing
> (the bot files are ignored by Render's build) or move the web files to a
> separate directory first.

### 2. Connect the repo to Render

1. Go to https://dashboard.render.com → **New +** → **Blueprint**
2. Connect your GitHub account if you haven't
3. Pick the `osrs-margin-tracker` repo
4. Render reads `render.yaml` and creates the service automatically
5. Click **Apply** — first build takes ~5 minutes

### 3. Watch the deploy

Render's dashboard shows logs in real time. Successful sequence:

```
==> Installing Python deps from requirements-web.txt
==> npm install      (frontend)
==> npm run build    (produces frontend/dist)
==> Starting: gunicorn osrs_margin_api:app
==> Your service is live at https://osrs-margin-tracker.onrender.com
```

The first request after 15 min of inactivity takes ~30 s while the free-tier
service spins back up. Subsequent requests are instant.

## Local development is unchanged

`start.bat` / `start.ps1` still work for local dev. Flask only switches into
"serve the React build" mode when `frontend/dist` exists on disk — running
`npm run dev` separately for live reload keeps that folder empty and avoids
the catch-all route.

## Updating after the first deploy

Just push to `main` — Render auto-deploys every push. No CLI needed.

```bash
git add .
git commit -m "tweak X"
git push
```

## Troubleshooting

**Build fails on `npm install`**: bump `NODE_VERSION` in `render.yaml`.

**Wiki API blocks requests**: edit `HEADERS` in `osrs_herb_margins.py` and put a
real contact email in the User-Agent. The wiki maintainers ask for this so
they can reach you if you're hitting them too hard.

**App is slow on first load**: that's the free-tier cold start (~30 s).
Upgrading to Render's $7/mo Starter plan removes it.
