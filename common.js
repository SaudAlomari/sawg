'use strict';
// Shared helpers for the player site (app.js) and the admin page (admin.js).

const SAWG = {
  // The repo the admin page saves to. Change if the repo is renamed.
  owner: 'SaudAlomari',
  repo: 'sawg',
  branch: 'main',
};

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children.filter((c) => c != null));
  return e;
}

function showMsg(p, text) {
  p.textContent = text || '';
  p.hidden = !text;
}

// Makes answers match even when spelled slightly differently: ignores case,
// extra spaces, Arabic diacritics and tatweel, treats أ إ آ ٱ as ا, ى as ي,
// ة as ه, and Arabic digits as 0-9.
function normalize(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// 950 KB, 1.4 MB, 1.02 GB
function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '?';
  if (bytes === 0) return '0 KB';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// Size of a picture already on the site.
async function pictureSize(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? (await res.blob()).size : null;
  } catch {
    return null;
  }
}

// "Arrange the photo" puzzles: the photo is cut into grid×grid pieces.
// scramble[i] is the piece shown at place i; it's solved when every piece is home.
function photoAnswer(grid) {
  return Array.from({ length: grid * grid }, (_, i) => i).join(',');
}
function makeScramble(grid) {
  const n = grid * grid;
  let order;
  do {
    order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } while (order.filter((t, i) => t === i).length > Math.floor(n / 3)); // most pieces out of place
  return order;
}
function validScramble(s, grid) {
  const n = grid * grid;
  return Array.isArray(s) && s.length === n && [...s].sort((a, b) => a - b).every((v, i) => v === i) && s.some((v, i) => v !== i);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// "ال" doesn't matter: the same answer with ال added to or removed from the
// start of each word. The stored hash is checked against every version.
function answerVariants(answer) {
  const words = normalize(answer).split(' ').filter(Boolean);
  let out = [''];
  for (const w of words) {
    const bare = w.startsWith('ال') && w.length > 3 ? w.slice(2) : w;
    const forms = [...new Set([w, bare, 'ال' + bare])];
    out = out.flatMap((x) => forms.map((f) => (x ? x + ' ' : '') + f));
    if (out.length > 256) return [normalize(answer)]; // very long answers: exact match only
  }
  return out.length ? out : [normalize(answer)];
}

// Answers are stored as SHA-256 hashes so they can't be read from puzzles.json.
async function hashAnswer(puzzleId, answer) {
  const data = new TextEncoder().encode(puzzleId + ':' + normalize(answer));
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

// Passwords are stored as salted PBKDF2 hashes, never as plain text.
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 200000 },
    key,
    256
  );
  return toHex(bits);
}

async function loadJson(path) {
  // The query string skips GitHub Pages' cache so new players show up quickly.
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('تعذّر التحميل. تحقق من الإنترنت وحاول مرة أخرى.');
  return res.json();
}

// ---------- guess-the-word puzzles ----------
// Words are compared letter by letter after normalize() (أ إ آ = ا, ة = ه, ى = ي).

const WORD_MIN = 3;
const WORD_MAX = 7;
const WORD_GUESSES = 6;

function wordLetters(w) {
  return [...normalize(w).replace(/\s/g, '')];
}

// A word the dictionary can hold: Arabic letters only, 3 to 7 of them.
function cleanWord(w) {
  const s = String(w || '').replace(/[ً-ْٰـ]/g, '').trim();
  if (!/^[ء-ي]+$/.test(s)) return null;
  const n = wordLetters(s).length;
  return n >= WORD_MIN && n <= WORD_MAX ? s : null;
}

// Colours for a guess: 'ok' right place, 'near' in the word elsewhere, 'no' not in it.
function scoreGuess(guess, secret) {
  const g = wordLetters(guess);
  const s = wordLetters(secret);
  const out = g.map(() => 'no');
  const left = {};
  s.forEach((c, i) => {
    if (g[i] === c) out[i] = 'ok';
    else left[c] = (left[c] || 0) + 1;
  });
  g.forEach((c, i) => {
    if (out[i] !== 'ok' && left[c]) {
      out[i] = 'near';
      left[c]--;
    }
  });
  return out;
}

// The built-in words plus the admin's, without repeats.
async function loadWords() {
  const [base, mine] = await Promise.all([
    loadJson('data/words-base.json').catch(() => []),
    loadJson('data/words.json').catch(() => []),
  ]);
  const seen = new Set();
  return [...base, ...mine].filter((w) => {
    const k = wordLetters(w).join('');
    if (!cleanWord(w) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
