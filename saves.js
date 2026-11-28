'use strict';
// Players' progress and jewels are saved in usersSavedData.json in a separate
// repo (by default SaudAlomari/sawg-saves). The site writes it with a GitHub key
// that can ONLY touch that repo, so even if someone dug the key out of the site,
// they couldn't change the game itself or users.json.
//
// The key is stored lightly scrambled in data/settings.json so it isn't sitting
// there in plain text (and GitHub's leaked-key scanner doesn't cancel it).
// It is not real protection against a determined programmer.

const SAVES_FILE = 'usersSavedData.json';
const PENDING_FILE = 'pendingPuzzles.json'; // puzzles waiting for the admin, by id
const SIGNUPS_FILE = 'pendingSignups.json'; // sign-ups waiting for the admin, by username
const ANSWERS_FILE = 'puzzleAnswers.json'; // each puzzle's answers (lightly scrambled), so edits can show them
const MASK = 'sawg-trivia-saves';

function hideKey(key) {
  const bytes = new TextEncoder().encode(key).map((b, i) => b ^ MASK.charCodeAt(i % MASK.length));
  return btoa(String.fromCharCode(...bytes.reverse()));
}

function revealKey(hidden) {
  const bytes = Uint8Array.from(atob(hidden), (c) => c.charCodeAt(0)).reverse();
  return new TextDecoder().decode(bytes.map((b, i) => b ^ MASK.charCodeAt(i % MASK.length)));
}

// { repo, key } from settings, or null when saving isn't set up yet.
function savesConfig(settings) {
  if (!settings || !settings.savesRepo || !settings.saveKey) return null;
  try {
    return { repo: settings.savesRepo, key: revealKey(settings.saveKey) };
  } catch {
    return null;
  }
}

function savesFetch(cfg, opts = {}, path = SAVES_FILE) {
  return fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
}

function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function readSaves(cfg, file = SAVES_FILE) {
  const res = await savesFetch(cfg, { method: 'GET' }, file);
  if (res.status === 404) return { data: {}, sha: null };
  if (!res.ok) throw new Error(`saves read failed (${res.status})`);
  const body = await res.json();
  return { data: JSON.parse(b64ToUtf8(body.content)), sha: body.sha };
}

// Change usersSavedData.json and save it, retrying if someone else saved at the same moment.
async function updateSaves(cfg, change, message, file = SAVES_FILE) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, sha } = await readSaves(cfg, file);
    change(data);
    const res = await savesFetch(cfg, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: utf8ToB64(JSON.stringify(data, null, 2) + '\n'), ...(sha ? { sha } : {}) }),
    }, file);
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`saves write failed (${res.status})`);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new Error('saves busy');
}

// ---------- answers, so the edit form can show them ----------
// puzzles.json only has hashes of the answers. A copy of the answers is kept
// here, lightly scrambled like the pending ones.

async function sameAnswers(p, answers) {
  if (!Array.isArray(answers) || !answers.length || !p.answerHashes) return false;
  const hashes = await Promise.all(answers.map((a) => hashAnswer(p.id, a)));
  return hashes.every((h) => p.answerHashes.includes(h)) && p.answerHashes.every((h) => hashes.includes(h));
}

function readHidden(text) {
  try {
    return JSON.parse(revealKey(text));
  } catch {
    return null;
  }
}

async function saveAnswers(cfg, id, answers) {
  await updateSaves(cfg, (all) => {
    all[id] = hideKey(JSON.stringify(answers));
  }, `Answers for ${id}`, ANSWERS_FILE);
}

// Older puzzles came in through pendingPuzzles.json before this copy existed,
// so look for their answers in that file's history (once), keeping only
// answers that still match the puzzle.
async function recoverAnswers(cfg, puzzles) {
  const found = {};
  const shas = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/commits?path=${PENDING_FILE}&per_page=100&page=${page}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) break;
    const list = await res.json();
    shas.push(...list.map((c) => c.sha));
    if (list.length < 100) break;
  }
  const versions = [];
  for (let i = 0; i < shas.length; i += 10) {
    versions.push(...await Promise.all(shas.slice(i, i + 10).map(async (sha) => {
      try {
        const res = await savesFetch(cfg, {}, `${PENDING_FILE}?ref=${sha}`);
        return res.ok ? JSON.parse(b64ToUtf8((await res.json()).content)) : {};
      } catch {
        return {};
      }
    })));
  }
  // Newest first, so the latest answers that still match win.
  for (const p of puzzles) {
    for (const v of versions) {
      const hit = Object.values(v).find((x) => x && x.answersHidden && (x.edits || x.id) === p.id && x.type !== 'photo');
      const answers = hit && readHidden(hit.answersHidden);
      if (answers && (await sameAnswers(p, answers))) {
        found[p.id] = hit.answersHidden;
        break;
      }
    }
  }
  return found;
}

// Answers of older puzzles, worked out from their stored hashes and kept
// (lightly scrambled) in data/answers-seed.json as { id: { hash: answer } }.
let answerSeed = null;
async function seedAnswers(id) {
  if (!answerSeed) answerSeed = await loadJson('data/answers-seed.json').catch(() => ({}));
  return (answerSeed[id] && readHidden(answerSeed[id])) || {};
}

// Answers typed in an edit while some of the old ones stay unknown.
async function addSeenAnswers(cfg, id, answers) {
  const hashes = await Promise.all(answers.map((a) => hashAnswer(id, a)));
  await updateSaves(cfg, (all) => {
    const seen = (all['seen:' + id] && readHidden(all['seen:' + id])) || {};
    hashes.forEach((h, i) => (seen[h] = answers[i]));
    all['seen:' + id] = hideKey(JSON.stringify(seen));
  }, `Answers for ${id}`, ANSWERS_FILE);
}

// The current answers of a puzzle: { answers, missing } where missing lists
// the hashes of accepted answers still unknown; null when none are known.
async function loadAnswers(cfg, p, puzzles) {
  let { data } = await readSaves(cfg, ANSWERS_FILE);
  if (!data[p.id] && !data._searched) {
    const found = await recoverAnswers(cfg, puzzles.filter((x) => x.type !== 'photo' && !data[x.id]));
    data = await updateSaves(cfg, (all) => {
      Object.assign(all, found);
      all._searched = new Date().toISOString().slice(0, 10);
    }, 'Answers found in older puzzle submissions', ANSWERS_FILE);
  }
  const answers = data[p.id] && readHidden(data[p.id]);
  if (answers && (await sameAnswers(p, answers))) return { answers, missing: [] };
  // Otherwise, the answers worked out for older puzzles, plus any typed in edits.
  const seen = { ...(await seedAnswers(p.id)), ...((data['seen:' + p.id] && readHidden(data['seen:' + p.id])) || {}) };
  const hashes = p.answerHashes || [];
  const learned = hashes.filter((h) => typeof seen[h] === 'string').map((h) => seen[h]);
  if (!learned.length) return null;
  return { answers: learned, missing: hashes.filter((h) => typeof seen[h] !== 'string') };
}

// ---------- pictures players upload with their puzzles ----------
// Kept in pending/ in the saves repo until the admin approves the puzzle.

async function savesPutFile(cfg, path, bytes, message) {
  const res = await savesFetch(cfg, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64FromBytes(bytes) }),
  }, path);
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

async function savesGetBlob(cfg, path) {
  const res = await savesFetch(cfg, { headers: { Accept: 'application/vnd.github.raw+json' } }, path);
  if (!res.ok) throw new Error(`picture not found (${res.status})`);
  return res.blob();
}

async function savesDeleteFile(cfg, path, message) {
  const res = await savesFetch(cfg, {}, path);
  if (!res.ok) return;
  const { sha } = await res.json();
  await savesFetch(cfg, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sha }) }, path);
}

function b64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- groups ----------
// The admin puts players in groups (data/groups.json: [{ id, name }]; each
// user in users.json has a "group" id). Every group has its own leaderboard,
// and players only see people from their own group. Players never see group
// names. The default group always exists and can't be deleted; new players
// join it, and anyone without a group (or whose group was deleted) is in it.

const DEFAULT_GROUP = 'default';
const OTHER_GROUP_NAME = 'Other Group User';

// The groups list, always with the default group first.
function withDefaultGroup(groups) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id);
  const def = list.find((g) => g.id === DEFAULT_GROUP) || { id: DEFAULT_GROUP, name: 'Default' };
  return [def, ...list.filter((g) => g.id !== DEFAULT_GROUP)];
}

// A user's group id. groups (optional) is used to spot deleted groups.
function groupOf(u, groups) {
  const id = u && u.group;
  if (!id) return DEFAULT_GROUP;
  if (Array.isArray(groups) && groups.length && !groups.some((g) => g.id === id)) return DEFAULT_GROUP;
  return id;
}

// ---------- names and jewels ----------

const PUZZLE_GIFT = 1; // jewels for each of your puzzles that is in the game

// Who made a puzzle. Older puzzles only have the display name, so match it.
function ownerOf(p, users) {
  if (p.by) return p.by;
  const u = users.find((x) => x.displayName === p.author);
  return u ? u.username : null;
}

// A player's name: the one they set in their profile, else the sign-up one.
function displayNameOf(username, users, saves) {
  const s = saves && saves[username];
  if (s && s.displayName) return s.displayName;
  const u = users.find((x) => x.username === username);
  return u ? u.displayName : username;
}

// viewer: the player looking at it. Players only see the names of people in
// their own group; a puzzle by someone in another group shows OTHER_GROUP_NAME.
// The admin always sees the real name.
function puzzleAuthor(p, users, saves, viewer = null, groups = null) {
  const owner = ownerOf(p, users);
  if (owner && viewer && !viewer.admin) {
    const u = users.find((x) => x.username === owner);
    const v = users.find((x) => x.username === viewer.username) || viewer;
    if (u && groupOf(u, groups) !== groupOf(v, groups)) return OTHER_GROUP_NAME;
  }
  return owner ? displayNameOf(owner, users, saves) : p.author;
}

function puzzlesBy(username, puzzles, users) {
  return puzzles.filter((p) => ownerOf(p, users) === username);
}

// ---------- hints ----------
// A puzzle has up to 4 hints, each small (2 jewels) or big (4 jewels).
// Opened hints are saved as "puzzleId#number#s" or "…#b". Older saves hold
// just the puzzle id, from when there was one hint that cost 5.

const MAX_HINTS = 4;
const HINT_COSTS = { small: 2, big: 4 };
const OLD_HINT_COST = 5;
const POSTPONE_COST = 1;

function puzzleHints(p) {
  if (Array.isArray(p.hints)) return p.hints.filter((h) => h && h.text);
  return p.hint ? [{ text: p.hint, size: 'big' }] : [];
}

function hintKey(p, i, size) {
  return `${p.id}#${i}#${size === 'small' ? 's' : 'b'}`;
}

function hintOpened(hinted, p, i) {
  const old = !Array.isArray(p.hints) && hinted.includes(p.id);
  return old || hinted.some((h) => h.startsWith(`${p.id}#${i}#`));
}

function hintSpent(hinted) {
  return (hinted || []).reduce((sum, h) => {
    const m = /#(s|b)$/.exec(h);
    return sum + (m ? (m[1] === 's' ? HINT_COSTS.small : HINT_COSTS.big) : OLD_HINT_COST);
  }, 0);
}

// What solving a puzzle earns: 2, but 1 less for each wrong multiple-choice try,
// plus any extra (a 9-piece photo puzzle gives 1 more).
function solveReward(entry, id) {
  return Math.max(0, 2 - ((entry.misses || {})[id] || 0)) + ((entry.extra || {})[id] || 0);
}

const WORDLE_COST = 1;
const WORDLE_REWARD = 2;
const WORDLE_LENGTHS = [3, 4, 6, 7];

function savedJewels(entry, gifts = 0) {
  if (!entry) return gifts * PUZZLE_GIFT;
  const earned = (entry.solved || []).reduce((sum, id) => sum + solveReward(entry, id), 0);
  const w = entry.wordle || {}; // "العب كلمات": each word costs 1, solving it gives 2
  return earned - hintSpent(entry.hinted) - (entry.postpones || 0) * POSTPONE_COST + gifts * PUZZLE_GIFT
    + (w.won || 0) * WORDLE_REWARD - (w.bought || 0) * WORDLE_COST;
}

// ---------- leaderboard ----------
// Ranked by puzzles solved, then jewels. Players can hide their name.

// group (optional): only the players in that group.
function leaderboard(users, puzzles, saves, group = null, groups = null) {
  const live = new Set(puzzles.map((p) => p.id));
  return users
    .filter((u) => u.status === 'active' && (!group || groupOf(u, groups) === group))
    .map((u) => {
      const entry = (saves && saves[u.username]) || {};
      return {
        username: u.username,
        name: displayNameOf(u.username, users, saves),
        anonymous: !!entry.anonymous,
        hidden: !!entry.hideFromBoard,
        solved: (entry.solved || []).filter((id) => live.has(id)).length,
        live: puzzlesBy(u.username, puzzles, users).length,
        jewels: savedJewels(entry, puzzlesBy(u.username, puzzles, users).length),
      };
    })
    .sort((a, b) => b.solved - a.solved || b.jewels - a.jewels);
}
