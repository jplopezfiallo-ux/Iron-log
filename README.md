# Iron Log

A local-first strength training tracker. No account, no server — your data
lives in your phone's browser storage (IndexedDB) and never leaves the
device unless you export a backup file yourself.

## Features
- Multiple profiles (log workouts for more than one person)
- Freeform logging or reusable routines/templates
- Per-set weight + reps (each set can differ)
- Editable exercise library with custom icons
- History of past workouts
- Progress charts per exercise: weight or volume (sets×reps×weight) over time,
  with an option to overlay multiple profiles on the same chart
- Personal record (PR) badges
- Export / import your data as a backup file

## Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `iron-log`).
2. Upload all the files in this folder to the repo, keeping the same
   structure (`index.html` at the root, `css/`, `js/`, `icons/` as
   subfolders).
3. In the repo, go to **Settings → Pages**.
4. Under "Build and deployment", set **Source** to "Deploy from a branch",
   pick your main branch and the `/ (root)` folder, then save.
5. GitHub gives you a URL like `https://yourname.github.io/iron-log/`.
   It can take a minute or two to go live the first time.

## Install on your Android phone

1. Open the GitHub Pages URL in Chrome on your phone.
2. Tap the **⋮** menu → **Add to Home screen** (or use the install banner
   if Chrome shows one).
3. Confirm — an "Iron Log" icon appears on your home screen.
4. Open it once while online so the service worker finishes caching
   everything it needs to run offline afterward.

## Updating later

When new features are added, re-upload the changed files to the same repo.
The next time you open the app with an internet connection, it fetches the
new version in the background and swaps it in — usually on that open or the
next one. Your logged data is stored separately in IndexedDB and is not
touched by app updates.

## Backups

Use **Profiles → Export data** periodically, especially before clearing
browser data or switching phones. **Profiles → Import data** restores from
a backup file.
