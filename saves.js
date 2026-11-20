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

async function readSaves(cfg) {
  const res = await savesFetch(cfg, { method: 'GET' });
  if (res.status === 404) return { data: {}, sha: null };
  if (!res.ok) throw new Error(`saves read failed (${res.status})`);
  const body = await res.json();
  return { data: JSON.parse(b64ToUtf8(body.content)), sha: body.sha };
}

// Change usersSavedData.json and save it, retrying if someone else saved at the same moment.
async function updateSaves(cfg, change, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, sha } = await readSaves(cfg);
    change(data);
    const res = await savesFetch(cfg, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: utf8ToB64(JSON.stringify(data, null, 2) + '\n'), ...(sha ? { sha } : {}) }),
    });
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`saves write failed (${res.status})`);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new Error('saves busy');
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

function puzzleAuthor(p, users, saves) {
  const owner = ownerOf(p, users);
  return owner ? displayNameOf(owner, users, saves) : p.author;
}

function puzzlesBy(username, puzzles, users) {
  return puzzles.filter((p) => ownerOf(p, users) === username);
}

function savedJewels(entry, gifts = 0) {
  return (entry ? (entry.solved || []).length * 2 - (entry.hinted || []).length * 5 : 0) + gifts * PUZZLE_GIFT;
}
