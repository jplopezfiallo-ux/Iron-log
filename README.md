# Iron Log

A local-first strength training tracker. No account, no server — your data
lives in your phone's browser storage (IndexedDB) and never leaves the
device unless you export a backup file yourself.

## Features
- Multiple profiles (log workouts for more than one person)
- Freeform logging or reusable routines/templates
- Per-set weight + reps (each set can differ)
- Weighted and bodyweight exercise tracking — bodyweight movements record sets
  and reps without a weight field
- Exercise categories, category filters, and name search
- kg/lbs unit toggle — data is always stored consistently; switching units
  only changes how numbers are displayed, including on charts
- Editable exercise library with custom icons (21 built-in exercises)
- In-progress workouts persist automatically — close the app mid-workout and
  it picks back up right where you left off, no matter how much later you
  return
- Log a workout on a past date via the date picker on the Log screen
- History with a calendar view (see which days you trained at a glance) plus
  a per-workout detail view (exercises, weight, and reps per set)
- Progress charts per exercise: weight or volume (sets×reps×weight) over time,
  with a rolling time-range selector (7 days / 30 days / 1 year / year-to-date
  / all time) and a stock-ticker-style % change indicator
- Personal record (PR) badges
- Multi-profile overlay on progress charts (compare users on one chart)
- Export / import your data as a backup file
- Validated, transaction-safe backup imports with merge and replace options

## Version 3

- Added weighted and bodyweight exercise modes.
- Added Shoulders, Chest, Arms, Back, Legs, and Abs categories, plus an
  Uncategorized fallback for existing custom exercises.
- Added exercise search and category filters throughout the app.
- Corrected local workout dates, completed-workout progress calculations,
  duplicate exercise handling, last-profile deletion, and cache isolation.
- Upgraded backup imports with validation, relationship checks, merge/replace
  previews, and transaction rollback on failure.

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
