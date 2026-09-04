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

## Shared rooms (optional)

Out of the box every visitor gets a private notebook in their own browser.
Turning on shared rooms adds a **Share** button that turns the current
notebook into a link — anyone who opens it sees the same notebook and edits
appear for everyone within a second.

GitHub Pages only serves files, so this needs a database. Firebase's free
tier is enough and there is no server to run.

### Setting it up

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and create a project. Google Analytics is not needed.
2. **Build → Firestore Database → Create database.** Start in *production
   mode*; the rules below replace the defaults.
3. **Build → Authentication → Get started → Anonymous → Enable.** Visitors
   never see a sign-in; this just gives each browser an identity the rules can
   check.
4. **Project settings → General → Your apps → Web (`</>`)**. Register the app
   and copy the `firebaseConfig` values into `web/firebase-config.js`.
5. In **Firestore → Rules**, paste this and publish:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{room}/{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

6. Rebuild and push:

   ```bash
   npm run web
   git add docs web/firebase-config.js
   git commit -m "Enable shared rooms"
   git push
   ```

The config values are safe to commit. They identify the project, they don't
grant access — that's what the rules above are for. Firebase's own docs say
the same.

### What to know before you share a link

- **The link is the password.** Anyone holding it can read and edit that room,
  and anyone they forward it to can too. Room ids are ten random characters,
  so they can't realistically be guessed, but there is no other protection.
- **No history and no undo for other people's edits.** Your `Ctrl+Z` only
  walks back your own changes.
- **Two people editing the same page at once**: whoever saves last wins that
  page. Different pages never collide — each page is its own document. Finer
  merging is the obvious next step if this becomes a problem.
- **Free tier limits** are 50,000 reads and 20,000 writes a day, which is a
  lot for a handful of people but not unlimited.

Leaving `web/firebase-config.js` empty disables all of this cleanly: no Share
button, no network calls, everything stays local.

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
