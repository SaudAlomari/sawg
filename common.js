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

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

// Codes players send to the admin: "SAWG-USER-..." or "SAWG-PUZZLE-...".
function makeCode(kind, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `SAWG-${kind}-` + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readCode(text) {
  const m = /SAWG-(USER|PUZZLE)-([A-Za-z0-9_-]+)/.exec(String(text || '').replace(/\s+/g, ''));
  if (!m) throw new Error("That doesn't look like a SAWG code.");
  const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  return { kind: m[1], data: obj };
}

async function loadJson(path) {
  // The query string skips GitHub Pages' cache so new players show up quickly.
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load ' + path);
  return res.json();
}

// Share text on WhatsApp (or copy it) so the player can send their code.
function shareButtons(text) {
  const copy = el('button', { type: 'button', textContent: 'Copy code' });
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied ✓';
    } catch {
      copy.textContent = 'Select the code above and copy it';
    }
  };
  const wa = el('a', {
    className: 'button primary',
    textContent: 'Send on WhatsApp',
    href: 'https://wa.me/?text=' + encodeURIComponent(text),
    target: '_blank',
    rel: 'noopener',
  });
  return el('div', { className: 'row' }, wa, copy);
}
