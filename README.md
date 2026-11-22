# SAWG Trivia

A family & friends trivia and puzzle game that runs entirely on GitHub, with no server.

- **The site** is plain HTML/JS hosted on **GitHub Pages**.
- **Data** is stored as JSON files in this repo: `data/users.json` and `data/puzzles.json`. Puzzle pictures go in `images/`.
- **Players** sign up with a username and password, without needing a GitHub account.
- **Language:** the player site is in Arabic (right-to-left). The admin tools are in English.
- **Answers** are forgiving: case, extra spaces, Arabic diacritics, أ/إ/آ vs ا, ة vs ه, ى vs ي and Arabic vs Western digits don't matter.

## How it works

1. **Sign up.** A player picks a username and password. The request (with the password hashed, never in plain text) waits in `pendingSignups.json` in the saves repo.
2. **Activate.** Waiting sign-ups show at the top of Admin → **Users**. The admin taps **Activate** (saved into `data/users.json`; they can sign in about a minute later) or **Reject**.
3. **Play.** Puzzles are shown one at a time, page by page. Wrong answers can be retried, or players can skip.
   - **Jewels 💎:** each solved puzzle earns 2 jewels, and each of your puzzles in the game gives 1. A puzzle can have up to 4 hints; a small hint costs 2 jewels and a big one 4. A bought hint stays visible for free.
   - **Puzzles:** players send puzzles from the site; they wait under Admin → Pending (stored in `pendingPuzzles.json` in the saves repo) until approved.
   - **Leaderboard:** ranks players by puzzles solved, then jewels. Players can show as "مجهول" (set in their profile); the admin still sees who. They can also leave the leaderboard entirely; only the admin sees who left.
   - **Answers in edit form:** a copy of each puzzle's answers (lightly scrambled) is kept in `puzzleAnswers.json` in the saves repo. Older puzzles that came in as pending are found once in `pendingPuzzles.json` history; answers of older puzzles were worked out from their hashes and are kept, lightly scrambled, in `data/answers-seed.json`.
   - **Guess the word (خمّن الكلمة):** admin-only puzzle type with a letter count (3–7, reward = letters − 1). Each player gets a random word of that length from `data/words-base.json` (built-in, hidden from Admin) plus `data/words.json` (added under Admin → Word dictionary); 6 tries, then a new word. Letters are exact (ه≠ة, ي≠ى); only alef forms count as one.
4. **Submit a puzzle.** Players fill in the puzzle form (pictures included). It waits under Admin → **Pending** until the admin approves it into `data/puzzles.json`.

The admin can also deactivate or delete users and delete puzzles from the Admin page. Puzzles the admin adds or edits go into the game straight away.

## One-time setup (about 5 minutes, works on a phone)

1. **Make the repo public:** Settings → General → scroll to *Danger Zone* → *Change visibility* → *Public*. Free GitHub Pages needs a public repo.
2. **Turn on GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. After a minute or two the site is live at **https://saudalomari.github.io/sawg/**.
3. **Sign up first.** The very first person to sign up becomes the **admin** and is activated straight away. The sign-up form also asks for a GitHub key once and shows how to make one: a fine-grained token with access to only the `sawg` repo and *Contents: Read and write*. The key is saved only on that device. If you sign in as admin on another device, the Admin tab asks for the key again.

## Saving progress and jewels (about 5 minutes, phone OK)

Players' progress and jewels are saved in **`usersSavedData.json`** in a **separate repo**, `sawg-saves`. The site writes to it with a GitHub key that can **only** change that repo. The key is stored scrambled in `data/settings.json`. Someone determined could still dig it out, but at worst they could only mess with saved progress, never the game, the puzzles or `users.json`. Until this is set up, progress is kept on each player's device.

1. **Create the saves repo:** on GitHub tap **+** → *New repository*. Name it `sawg-saves`, choose **Private**, tick *Add a README file*, and tap *Create repository*.
2. **Make the saves key:** open [New fine-grained token](https://github.com/settings/personal-access-tokens/new). Name it `sawg saves` and pick the longest expiration. Under *Repository access* choose **Only select repositories** → **sawg-saves** (only that one!). Under *Permissions* set **Contents → Read and write**. Generate it and copy it.
3. **Connect it:** on the site, open **Admin** → *Saving progress*, paste the key and tap **Save**. It should say "✅ Saving to SaudAlomari/sawg-saves". If the key can also change the `sawg` repo, the admin page refuses it.

Players' progress then follows them to any device, and Admin → Users shows each player's solved count and jewels. If the key expires, make a new one and paste it again.

## Limits to know about (fine for family & friends)

- **Data is public.** Because the repo is public, anyone can read `users.json`. It holds usernames, display names and *scrambled* passwords (salted PBKDF2), never the real passwords. A very simple password could still be guessed by someone determined, so ask players not to reuse an important password.
- **Answers are scrambled** in `puzzles.json` (SHA-256), so they can't simply be read. Very short answers, like a number, could still be guessed by someone determined.
- **Sign-in happens in the browser.** It's a light lock, not real security.
- **Progress** is saved on each device until saving is set up. After that it's saved in `usersSavedData.json` in the `sawg-saves` repo and follows players to any device.
- **Changes take about a minute** to show on the site, while GitHub Pages updates.
- **Size:** pictures are capped at 2 MB. GitHub allows 100 MB per file and recommends staying under about 1 GB for the whole repo, which leaves room for hundreds of puzzles.

These could be improved later with a small backend, for example a leaderboard, progress that syncs across devices, and stronger sign-in.

## Files

```
index.html, app.js     the player site
admin.js               the admin tools (Admin tab)
common.js              shared helpers (repo name is set here)
style.css              styles
data/users.json        activated players
data/puzzles.json      approved puzzles
images/                puzzle pictures
```
