# SAWG Trivia

A family & friends trivia and puzzle game that runs entirely on GitHub, with no server.

- **The site** is plain HTML/JS hosted on **GitHub Pages**.
- **Data** is stored as JSON files in this repo: `data/users.json` and `data/puzzles.json`. Puzzle pictures go in `images/`.
- **Players** sign up with a username and password, without needing a GitHub account.
- **Language:** the player site is in Arabic (right-to-left). The admin tools are in English.
- **Answers** are forgiving: case, extra spaces, Arabic diacritics, أ/إ/آ vs ا, ة vs ه, ى vs ي and Arabic vs Western digits don't matter.

## How it works

1. **Sign up.** A player picks a username and password. The site gives them a **sign-up code** (the password is scrambled inside it), which they send to the admin, for example on WhatsApp.
2. **Activate.** The admin signs in, opens the **Admin** tab, pastes the code and taps **Activate**. The user is saved into `data/users.json`. About a minute later they can sign in.
3. **Play.** Puzzles are shown one at a time, page by page. Wrong answers can be retried, and players can use a hint if the puzzle has one, or skip.
4. **Submit a puzzle.** Players fill in the puzzle form and get a **puzzle code** to send to the admin, with a picture if there is one. The admin pastes the code in Admin, attaches the picture and taps **Approve**. It's saved into `data/puzzles.json`.

The admin can also deactivate or delete users and delete puzzles from the Admin page. To add your own puzzle, fill in *Submit a puzzle*, then paste the code in Admin.

## One-time setup (about 5 minutes, works on a phone)

1. **Make the repo public:** Settings → General → scroll to *Danger Zone* → *Change visibility* → *Public*. Free GitHub Pages needs a public repo.
2. **Turn on GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. After a minute or two the site is live at **https://saudalomari.github.io/sawg/**.
3. **Sign up first.** The very first person to sign up becomes the **admin** and is activated straight away. The sign-up form also asks for a GitHub key once and shows how to make one: a fine-grained token with access to only the `sawg` repo and *Contents: Read and write*. The key is saved only on that device. If you sign in as admin on another device, the Admin tab asks for the key again.

## Limits to know about (fine for family & friends)

- **Data is public.** Because the repo is public, anyone can read `users.json`. It holds usernames, display names and *scrambled* passwords (salted PBKDF2), never the real passwords. A very simple password could still be guessed by someone determined, so ask players not to reuse an important password.
- **Answers are scrambled** in `puzzles.json` (SHA-256), so they can't simply be read. Very short answers, like a number, could still be guessed by someone determined.
- **Sign-in happens in the browser.** It's a light lock, not real security.
- **Progress is saved on each player's device**, so it doesn't follow them to another phone. For the same reason there's no leaderboard yet.
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
