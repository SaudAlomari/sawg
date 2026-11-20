'use strict';
// The admin page. Saves to data/*.json and images/ in the repo through the
// GitHub API, using a key the admin enters on their own device. The key is
// kept in this browser only and is never part of the site's code.

const API = `https://api.github.com/repos/${SAWG.owner}/${SAWG.repo}/contents/`;
const $ = (s) => document.querySelector(s);
let token = null;
let tab = 'users';

try { token = localStorage.getItem('sawg-admin-token'); } catch {}

// ---------- GitHub ----------

function b64encodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decodeText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new Error('GitHub refused the key. It may have expired. Tap "Remove key from this phone" and add a new one.');
  if (res.status === 403) throw new Error('The key is not allowed to change the repo. Check it has Contents: Read and write.');
  return res;
}

async function readJson(name) {
  const res = await gh(`data/${name}.json?ref=${SAWG.branch}`);
  if (res.status === 404) return { data: [], sha: null };
  if (!res.ok) throw new Error(`Could not read ${name}.json (${res.status}).`);
  const body = await res.json();
  return { data: JSON.parse(b64decodeText(body.content)), sha: body.sha };
}

async function putFile(path, bytes, message, sha) {
  return gh(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64encodeBytes(bytes), branch: SAWG.branch, ...(sha ? { sha } : {}) }),
  });
}

// Read, change, save. If the file changed in between, read again and retry.
async function updateJson(name, change, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, sha } = await readJson(name);
    change(data);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
    const res = await putFile(`data/${name}.json`, bytes, message, sha);
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`Could not save ${name}.json (${res.status}).`);
  }
  throw new Error('Saving failed. Please try again.');
}

// ---------- screens ----------

function start() {
  $('#setup').hidden = !!token;
  $('#admin').hidden = !token;
  $('#nav').hidden = !token;
  if (token) refresh();
}

$('#key-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#key-form .error');
  showMsg(err);
  token = e.target.token.value.trim();
  try {
    const res = await fetch(`https://api.github.com/repos/${SAWG.owner}/${SAWG.repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const repo = await res.json();
    if (!res.ok) throw new Error("That key doesn't work for the sawg repo. Check you picked the sawg repository.");
    if (repo.permissions && !repo.permissions.push) throw new Error('That key can only read. Set Contents to Read and write.');
    try { localStorage.setItem('sawg-admin-token', token); } catch {}
    start();
  } catch (e2) {
    token = null;
    showMsg(err, e2.message);
  }
};

$('#forget').onclick = () => {
  if (!confirm('Remove the GitHub key from this phone?')) return;
  try { localStorage.removeItem('sawg-admin-token'); } catch {}
  token = null;
  start();
};

document.querySelectorAll('[data-tab]').forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $('#users').hidden = tab !== 'users';
    $('#puzzles').hidden = tab !== 'puzzles';
  };
});

function saved(text) {
  showMsg($('#saved'), text);
  setTimeout(() => showMsg($('#saved')), 6000);
}

// Run a save, with the button disabled while it works.
async function doSave(button, fn) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Saving…';
  try {
    await fn();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- lists ----------

async function refresh() {
  try {
    const [{ data: users }, { data: puzzles }] = await Promise.all([readJson('users'), readJson('puzzles')]);
    renderUsers(users);
    renderPuzzles(puzzles);
  } catch (e) {
    $('#users').replaceChildren(el('li', { className: 'error', textContent: e.message }));
  }
}

function renderUsers(users) {
  const list = $('#users');
  list.replaceChildren();
  if (!users.length) list.append(el('li', { className: 'empty', textContent: 'No users yet. Paste a sign-up code above.' }));
  [...users].reverse().forEach((u) => {
    const active = u.status === 'active';
    const toggle = el('button', { textContent: active ? 'Deactivate' : 'Activate', className: active ? 'bad' : 'ok' });
    toggle.onclick = () => doSave(toggle, async () => {
      await updateJson('users', (all) => {
        const x = all.find((y) => y.username === u.username);
        if (x) x.status = active ? 'inactive' : 'active';
      }, `${active ? 'Deactivate' : 'Activate'} user ${u.username}`);
      saved(`${u.displayName} is now ${active ? 'inactive' : 'active'}.`);
      refresh();
    });
    const del = el('button', { textContent: 'Delete', className: 'link' });
    del.onclick = () => {
      if (!confirm(`Delete ${u.displayName} for good?`)) return;
      doSave(del, async () => {
        await updateJson('users', (all) => {
          const i = all.findIndex((y) => y.username === u.username);
          if (i >= 0) all.splice(i, 1);
        }, `Delete user ${u.username}`);
        saved(`${u.displayName} was deleted.`);
        refresh();
      });
    };
    list.append(el('li', {},
      el('strong', { textContent: u.displayName }), ' ',
      el('span', { className: 'status ' + (active ? 'approved' : 'rejected'), textContent: u.status }),
      el('div', { className: 'meta', textContent: `@${u.username} · joined ${u.joinedAt || ''}` }),
      el('div', { className: 'row' }, toggle, del)));
  });
}

function renderPuzzles(puzzles) {
  const list = $('#puzzles');
  list.replaceChildren();
  if (!puzzles.length) list.append(el('li', { className: 'empty', textContent: 'No puzzles yet.' }));
  puzzles.forEach((p, n) => {
    const del = el('button', { textContent: 'Delete', className: 'link' });
    del.onclick = () => {
      if (!confirm('Delete this puzzle from the game?')) return;
      doSave(del, async () => {
        await updateJson('puzzles', (all) => {
          const i = all.findIndex((y) => y.id === p.id);
          if (i >= 0) all.splice(i, 1);
        }, `Delete puzzle ${p.id}`);
        saved('Puzzle deleted.');
        refresh();
      });
    };
    list.append(el('li', {},
      el('div', { textContent: `${n + 1}. ${p.question}`, style: 'white-space:pre-wrap;font-weight:600' }),
      p.image ? el('img', { src: p.image, alt: '' }) : null,
      p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
      el('div', { className: 'meta', textContent: `By ${p.author} · ${p.addedAt || ''}` }),
      el('div', { className: 'row' }, del)));
  });
}

// ---------- pasted codes ----------

$('#code').oninput = () => {
  const preview = $('#preview');
  const err = $('#code-error');
  preview.replaceChildren();
  showMsg(err);
  const text = $('#code').value.trim();
  if (!text) return;
  let parsed;
  try {
    parsed = readCode(text);
  } catch {
    return showMsg(err, "That doesn't look like a SAWG code. Make sure you copied all of it.");
  }
  if (parsed.kind === 'USER') previewUser(parsed.data);
  else previewPuzzle(parsed.data);
};

function clearCode() {
  $('#code').value = '';
  $('#preview').replaceChildren();
}

function previewUser(u) {
  const btn = el('button', { className: 'primary', textContent: `Activate ${u.displayName}` });
  btn.onclick = () => doSave(btn, async () => {
    await updateJson('users', (all) => {
      if (all.some((x) => x.username === u.username)) throw new Error(`The username "${u.username}" is already taken. Ask them to sign up with another one.`);
      all.push({
        username: normalize(u.username),
        displayName: String(u.displayName).slice(0, 40),
        salt: u.salt,
        hash: u.hash,
        status: 'active',
        joinedAt: new Date().toISOString().slice(0, 10),
      });
    }, `Activate user ${u.username}`);
    clearCode();
    saved(`${u.displayName} is activated! They can sign in in about a minute.`);
    refresh();
  });
  $('#preview').append(el('div', { className: 'list' }, el('li', {},
    el('div', { textContent: 'Sign-up request' , className: 'meta' }),
    el('strong', { textContent: u.displayName }),
    el('div', { className: 'meta', textContent: `Username: @${u.username}` }),
    el('div', { className: 'row' }, btn))));
}

function previewPuzzle(p) {
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  const img = el('img', { hidden: true, className: 'preview', alt: '' });
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    img.hidden = !f;
    if (f) img.src = URL.createObjectURL(f);
  };
  const btn = el('button', { className: 'primary', textContent: 'Approve and add to the game' });
  btn.onclick = () => doSave(btn, async () => {
    const id = 'p-' + Date.now().toString(36);
    let image = null;
    const f = fileInput.files[0];
    if (f) {
      if (f.size > 2 * 1024 * 1024) throw new Error('The picture must be under 2 MB.');
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[f.type];
      if (!ext) throw new Error('The picture must be PNG, JPG, GIF or WEBP.');
      image = `images/${id}.${ext}`;
      const res = await putFile(image, new Uint8Array(await f.arrayBuffer()), `Add image for ${id}`);
      if (!res.ok) throw new Error(`Could not upload the picture (${res.status}).`);
    }
    const answerHashes = await Promise.all(p.answers.map((a) => hashAnswer(id, a)));
    await updateJson('puzzles', (all) => {
      all.push({
        id,
        question: String(p.question).slice(0, 1000),
        type: p.type === 'choice' ? 'choice' : 'text',
        options: p.type === 'choice' ? p.options.slice(0, 6) : [],
        answerHashes,
        hint: String(p.hint || '').slice(0, 300),
        image,
        author: String(p.author || 'Someone').slice(0, 40),
        addedAt: new Date().toISOString().slice(0, 10),
      });
    }, `Add puzzle ${id} by ${p.by || p.author}`);
    clearCode();
    saved('Puzzle added! It shows in the game in about a minute.');
    refresh();
  });

  $('#preview').append(el('div', { className: 'list' }, el('li', {},
    el('div', { className: 'meta', textContent: `Puzzle from ${p.author}` }),
    el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600' }),
    p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
    el('div', { className: 'meta', textContent: 'Answer: ' + p.answers.join(' | ') }),
    p.hint ? el('div', { className: 'meta', textContent: 'Hint: ' + p.hint }) : null,
    el('label', {}, p.hasImage ? 'Picture (they said there is one, attach it here)' : 'Picture (optional)', fileInput),
    img,
    el('div', { className: 'row' }, btn))));
}

start();
