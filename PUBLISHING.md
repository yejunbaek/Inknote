# Putting InkNote on the web

The browser version lives in `docs/`, which is what GitHub Pages serves. It is
the same app as the desktop build — `src/` is the single source for both — with
browser storage swapped in for local files.

Rebuild it any time `src/` changes:

```bash
npm run web
```

Check it locally before publishing:

```bash
npx serve docs
```

## Publishing it

### If you have the GitHub CLI

From the project folder:

```bash
git init -b main
git add .
git commit -m "InkNote"
gh repo create inknote --public --source . --push
```

Then turn on Pages:

```bash
gh api -X POST repos/:owner/inknote/pages -f "source[branch]=main" -f "source[path]=/docs"
```

Your site appears at `https://<your-username>.github.io/inknote/` within a
minute or two.

### Without the CLI

1. Create a new **public** repository on github.com — call it `inknote`. Don't
   add a README; you already have one.
2. In the project folder:

   ```bash
   git init -b main
   git add .
   git commit -m "InkNote"
   git remote add origin https://github.com/<your-username>/inknote.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages**. Under *Build and deployment*, set
   **Source** to "Deploy from a branch", **Branch** to `main`, folder to
   `/docs`, and press Save.

## Updating the site

```bash
npm run web
git add docs
git commit -m "Update web build"
git push
```

Pages redeploys on its own, usually within a minute.

## What visitors get

- No account, no sign-up, no server. Everything is stored in the visitor's own
  browser via IndexedDB, and nothing is ever uploaded.
- A starter notebook on first visit, explaining the basics. It is only ever
  written when the browser has nothing stored, so it can't overwrite someone's
  work.
- **Export** and **Import** in the sidebar move a notebook between the web and
  desktop versions, and act as a backup.

Two limits worth knowing, both inherent to browser storage rather than bugs:

- Notes are per-browser and per-device. Someone opening the site on their phone
  won't see what they made on their laptop.
- Clearing site data, or using a private window, wipes them. The desktop build
  keeps notes in a real folder instead.

That's what an account would fix, when you want one later.

## Testing

```bash
npm i --no-save playwright
npm run web:test
```

Serves `docs/` over HTTP and drives it in real Chromium: boots, edits, reloads
and checks the work survived, saves an image and re-resolves it after a reload,
and confirms the app still renders when a browser refuses storage entirely.
HTTP rather than `file://` because IndexedDB is unavailable on file origins —
which is exactly what this build depends on.
