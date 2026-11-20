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
// extra spaces, Arabic diacritics and tatweel, treats أ إ آ as ا, ى as ي,
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

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
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
