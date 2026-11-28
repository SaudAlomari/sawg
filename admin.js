'use strict';
// Admin tools. Saves to data/*.json and images/ in the repo through the GitHub
// API, using a key the admin enters on their own device. The key is kept in
// this browser only and is never part of the site's code.

const GH_API = `https://api.github.com/repos/${SAWG.owner}/${SAWG.repo}`;
const SAVES_SITE_REPO = `${SAWG.owner}/${SAWG.repo}`;
const KEY_STEPS = [
  'Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → New fine-grained token ↗</a>',
  'Name: <code>sawg admin</code>. Expiration: up to 1 year.',
  'Repository access: <b>Only select repositories</b> → <b>sawg</b>.',
  'Permissions → Repository permissions → <b>Contents</b> → <b>Read and write</b>.',
  'Tap <b>Generate token</b>, copy it, and paste it here.',
];

let adminTab = 'users';

// ---------- the key ----------

function getKey() {
  try { return localStorage.getItem('sawg-admin-token'); } catch { return null; }
}
function setKey(key) {
  try {
    if (key) localStorage.setItem('sawg-admin-token', key);
    else localStorage.removeItem('sawg-admin-token');
  } catch {}
}

function fillKeySteps(root) {
  root.querySelectorAll('.key-steps').forEach((ol) => {
    ol.innerHTML = KEY_STEPS.map((s) => `<li>${s}</li>`).join('');
  });
}

// Checks a key can change the repo. Throws a friendly error if not.
async function checkKey(key) {
  let res;
  try {
    res = await fetch(GH_API, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' } });
  } catch {
    throw new Error("Couldn't reach GitHub. Check your internet and try again.");
  }
  if (!res.ok) throw new Error("That GitHub key doesn't work for the sawg repo. Check you picked the sawg repository.");
  const repo = await res.json();
  if (repo.permissions && !repo.permissions.push) throw new Error('That GitHub key can only read. Set Contents to "Read and write".');
}

// ---------- GitHub files ----------

function b64encodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decodeText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function gh(path, opts = {}, key = getKey()) {
  const res = await fetch(`${GH_API}/contents/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new Error('GitHub refused the key. It may have expired. Remove it from this device and add a new one.');
  if (res.status === 403) throw new Error('The GitHub key is not allowed to change the repo. Check it has Contents: Read and write.');
  return res;
}

async function readRepoJson(name, key) {
  const res = await gh(`data/${name}.json?ref=${SAWG.branch}`, {}, key);
  if (res.status === 404) return { data: name === 'settings' ? {} : [], sha: null };
  if (!res.ok) throw new Error(`Could not read ${name}.json (${res.status}).`);
  const body = await res.json();
  return { data: JSON.parse(b64decodeText(body.content)), sha: body.sha };
}

async function putFile(path, bytes, message, sha, key) {
  return gh(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64encodeBytes(bytes), branch: SAWG.branch, ...(sha ? { sha } : {}) }),
  }, key);
}

// Read, change, save. If the file changed in between, read again and retry.
async function updateRepoJson(name, change, message, key = getKey()) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, sha } = await readRepoJson(name, key);
    change(data);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
    const res = await putFile(`data/${name}.json`, bytes, message, sha, key);
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`Could not save ${name}.json (${res.status}).`);
  }
  throw new Error('Saving failed. Please try again.');
}

// The files in a folder, as { path: bytes }, or null if it can't be read.
async function listFolder(fetchPath, folder) {
  try {
    const res = await fetchPath(folder);
    if (res.status === 404) return {};
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return {};
    return Object.fromEntries(list.filter((f) => f.type === 'file' && f.name !== '.gitkeep').map((f) => [f.path, f.size]));
  } catch {
    return null;
  }
}

// ---------- adding and changing puzzles ----------

async function uploadPicture(buf, path, what, id) {
  const res = await putFile(path, new Uint8Array(buf), `Add ${what} for ${id}`);
  if (!res.ok) throw new Error(`Could not upload the ${what} (${res.status}).`);
  return path;
}

// Adds a new puzzle to puzzles.json, or changes one when p.edits names it.
// answers: plain answers (empty keeps the current ones when editing).
// pics.q / pics.a: { bytes: Promise<ArrayBuffer>, ext } to set, null to remove,
// undefined to keep what's there.
async function savePuzzle(p, answers, pics) {
  const editing = p.edits || null;
  const id = editing || (/^p-[\w-]+$/.test(p.id || '') ? p.id : 'p-' + Date.now().toString(36));
  // A changed picture gets a new name so phones don't keep showing the old one.
  const stamp = editing ? '-' + Date.now().toString(36) : '';
  const put = async (pic, name, what) => (pic ? uploadPicture(await pic.bytes, `images/${name}.${pic.ext}`, what, id) : pic);
  const image = await put(pics.q, `${id}${stamp}`, 'question picture');
  const answerImage = await put(pics.a, `${id}-answer${stamp}`, 'answer picture');
  const photo = p.type === 'photo';
  const word = p.type === 'word';
  const grid = p.grid === 3 ? 3 : 2;
  if (photo && (editing ? image === null : !image)) throw new Error('An "arrange the photo" puzzle needs a question picture.');
  // For a photo puzzle the answer is the pieces in order.
  if (photo) answers = [photoAnswer(grid)];
  let answerHashes = answers.length ? await Promise.all(answers.map((x) => hashAnswer(id, x))) : null;
  // Old answers nobody has typed yet stay accepted (keepHashes, when editing).
  const keep = editing && !photo && answerHashes && Array.isArray(p.keepHashes) ? p.keepHashes.filter((h) => /^[0-9a-f]{64}$/.test(h)) : [];
  if (keep.length) answerHashes = [...new Set([...answerHashes, ...keep])];
  if (word) answerHashes = []; // a random dictionary word each time
  if (!editing && !answerHashes) throw new Error('This puzzle has no answer.');
  const fields = {
    question: String(p.question).slice(0, 1000),
    type: photo ? 'photo' : word ? 'word' : p.type === 'choice' ? 'choice' : 'text',
    options: p.type === 'choice' ? (p.options || []).slice(0, 6) : [],
    hints: puzzleHints(p).slice(0, MAX_HINTS).map((h) => ({ text: String(h.text).slice(0, 300), size: h.size === 'small' ? 'small' : 'big' })),
    ...(photo ? { grid, scramble: validScramble(p.scramble, grid) ? p.scramble : makeScramble(grid) } : {}),
    ...(word ? { length: Math.min(WORD_MAX, Math.max(WORD_MIN, Number(p.length) || 5)) } : {}),
  };
  await updateRepoJson('puzzles', (all) => {
    if (editing) {
      const x = all.find((y) => y.id === id);
      if (!x) throw new Error('That puzzle is no longer in the game.');
      Object.assign(x, fields);
      delete x.hint;
      if (!photo) {
        delete x.grid;
        delete x.scramble;
      }
      if (!word) delete x.length;
      if (answerHashes) x.answerHashes = keep.length ? answerHashes.filter((h) => !keep.includes(h) || (x.answerHashes || []).includes(h)) : answerHashes;
      if (image !== undefined) x.image = image;
      if (answerImage !== undefined) x.answerImage = answerImage;
      x.editedAt = new Date().toISOString().slice(0, 10);
      return;
    }
    if (all.some((x) => x.id === id)) return;
    all.push({
      id,
      ...fields,
      answerHashes,
      image: image || null,
      answerImage: answerImage || null,
      author: String(p.author || 'Someone').slice(0, 40),
      ...(p.by ? { by: String(p.by).slice(0, 20) } : {}),
      addedAt: new Date().toISOString().slice(0, 10),
    });
  }, editing ? `Edit puzzle ${id}` : `Add puzzle ${id} by ${p.by || p.author}`);
  // Keep a copy of the answers so the edit form can show them later.
  if (!photo && !word && answers.length) {
    const cfg = savesConfig(settings) || savesConfig((await readRepoJson('settings').catch(() => ({}))).data);
    if (cfg) await (keep.length ? addSeenAnswers(cfg, id, answers) : saveAnswers(cfg, id, answers)).catch(() => {});
  }
  return id;
}

// ---------- admin screens ----------

function adminView(app) {
  if (!getKey()) return keyView(app);
  app.replaceChildren(document.getElementById('t-admin').content.cloneNode(true));
  const $ = (s) => app.querySelector(s);

  const showTab = (name) => {
    adminTab = name;
    app.querySelectorAll('[data-admin-tab]').forEach((x) => x.classList.toggle('active', x.dataset.adminTab === name));
    $('#a-users').hidden = name !== 'users';
    $('#a-puzzles').hidden = name !== 'puzzles';
    $('#a-pending').hidden = name !== 'pending';
    $('#a-words').hidden = name !== 'words';
    $('#a-groups').hidden = name !== 'groups';
  };
  app.querySelectorAll('[data-admin-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.adminTab)));
  showTab(adminTab);

  $('#forget').onclick = () => {
    if (!confirm('Remove the GitHub key from this device? You can add it again later.')) return;
    setKey(null);
    keyView(app);
  };

  const saved = (text) => {
    showMsg($('#saved'), text);
    setTimeout(() => $('#saved') && showMsg($('#saved')), 6000);
  };

  // Run a save, with the button disabled while it works.
  const doSave = async (button, fn) => {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Saving…';
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  let lastCfg = null;
  let lastPuzzles = [];

  // ----- word dictionary (for "guess the word" puzzles) -----
  // Lists only the admin's own words (data/words.json); the built-in list
  // (data/words-base.json) is used in play and for spotting repeats.
  let baseWords = null;
  const wordKey = (w) => wordLetters(w).join('');
  async function renderWords() {
    const list = $('#w-list');
    if (!list) return;
    try {
      if (!baseWords) baseWords = await loadJson('data/words-base.json').catch(() => []);
      const { data: mine } = await readRepoJson('words');
      if (!$('#w-list')) return;
      const counts = {};
      new Set([...baseWords, ...mine].map(wordKey)).forEach((k) => (counts[k.length] = (counts[k.length] || 0) + 1));
      $('#w-counts').textContent = 'Words in the game by length (built-in + yours): ' +
        [3, 4, 5, 6, 7].map((n) => `${n} letters: ${counts[n] || 0}`).join(' · ');
      $('#w-mine-count').textContent = `(${mine.length})`;
      list.replaceChildren();
      if (!mine.length) list.append(el('li', { className: 'empty', textContent: 'You haven\'t added any words yet.' }));
      [...mine].sort((a, b) => wordKey(a).length - wordKey(b).length || a.localeCompare(b, 'ar')).forEach((w) => {
        const del = el('button', { className: 'link', textContent: 'Remove' });
        del.onclick = () => {
          if (!confirm(`Remove "${w}" from the dictionary?`)) return;
          doSave(del, async () => {
            await updateRepoJson('words', (all) => {
              const i = all.indexOf(w);
              if (i >= 0) all.splice(i, 1);
            }, `Remove word ${w}`);
            saved('Word removed.');
            renderWords();
          });
        };
        list.append(el('li', { className: 'word-item' },
          el('span', { textContent: w, dir: 'rtl', lang: 'ar', style: 'font-weight:700;font-size:1.15rem' }),
          el('span', { className: 'muted small', textContent: ` ${wordKey(w).length} letters ` }), del));
      });
    } catch (e) {
      list.replaceChildren(el('li', { className: 'error', textContent: e.message }));
    }
  }

  $('#w-form').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#w-msg');
    const typed = e.target.words.value.split(/[\s,،]+/).filter(Boolean);
    const bad = typed.filter((w) => !cleanWord(w));
    const words = typed.map(cleanWord).filter(Boolean).filter((w, i, all) => all.findIndex((x) => wordKey(x) === wordKey(w)) === i);
    const button = e.target.querySelector('[type=submit]');
    if (!words.length) {
      msg.className = 'small error';
      msg.textContent = bad.length ? `Not added: ${bad.join(', ')}. Use Arabic letters only, 3 to 7 letters.` : 'Type a word first.';
      return;
    }
    let added = [];
    let already = [];
    let ok = false;
    await doSave(button, async () => {
      if (!baseWords) baseWords = await loadJson('data/words-base.json').catch(() => []);
      await updateRepoJson('words', (all) => {
        added = [];
        already = [];
        const have = new Set([...baseWords, ...all].map(wordKey));
        for (const w of words) {
          if (have.has(wordKey(w))) already.push(w);
          else {
            have.add(wordKey(w));
            all.push(w);
            added.push(w);
          }
        }
        if (!added.length) throw new Error('nothing new');
      }, `Add words: ${words.join(' ')}`).catch((err) => {
        if (err.message !== 'nothing new') throw err;
      });
      ok = true;
    });
    if (!ok) return;
    const parts = [];
    if (added.length) parts.push(`✅ Added: ${added.join('، ')}`);
    if (already.length) parts.push(`⚠️ Already in the dictionary: ${already.join('، ')}`);
    if (bad.length) parts.push(`❌ Not added (Arabic letters only, 3 to 7 letters): ${bad.join('، ')}`);
    msg.className = 'small' + (added.length ? '' : ' error');
    msg.textContent = parts.join(' · ');
    if (added.length) e.target.words.value = '';
    renderWords();
  };
  renderWords();

  async function refresh() {
    try {
      const [{ data: users }, { data: puzzles }, { data: settings }, { data: groupList }] = await Promise.all([
        readRepoJson('users'), readRepoJson('puzzles'), readRepoJson('settings'), readRepoJson('groups'),
      ]);
      const groups = withDefaultGroup(groupList);
      const cfg = savesConfig(settings);
      lastCfg = cfg;
      lastPuzzles = puzzles;
      const [saves, signups] = cfg
        ? await Promise.all([readSaves(cfg).then((r) => r.data).catch(() => null), readSaves(cfg, SIGNUPS_FILE).then((r) => r.data).catch(() => ({}))])
        : [null, {}];
      if (!$('#a-users')) return; // left the admin page meanwhile
      renderUsers(users, saves, puzzles, signups, cfg, groups);
      renderGroups(groups, users, saves);
      const imgs = await listFolder((p) => gh(`${p}?ref=${SAWG.branch}`), 'images');
      if (!$('#a-puzzles')) return;
      renderPuzzles(puzzles, users, saves, imgs || {}, groups);
      renderSaves(settings, cfg, saves);
      renderStorage(cfg, imgs);
      const pending = cfg ? await readSaves(cfg, PENDING_FILE).then((r) => r.data).catch(() => ({})) : null;
      if ($('#a-pending')) renderPending(pending);
    } catch (e) {
      if ($('#a-users')) $('#a-users').replaceChildren(el('li', { className: 'error', textContent: e.message }));
    }
  }

  // ----- storage -----

  async function renderStorage(cfg, imgs) {
    const GB = 1024 * 1024 * 1024;
    const repoSize = async (url, key) => {
      try {
        const res = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' } });
        return res.ok ? ((await res.json()).size || 0) * 1024 : null;
      } catch {
        return null;
      }
    };
    const total = (files) => (files ? Object.values(files).reduce((a, b) => a + b, 0) : null);
    const [site, savesRepo, pendingPics] = await Promise.all([
      repoSize(GH_API, getKey()),
      cfg ? repoSize(`https://api.github.com/repos/${cfg.repo}`, cfg.key) : null,
      cfg ? listFolder((p) => savesFetch(cfg, {}, p), 'pending') : null,
    ]);
    const rows = [
      ['Site repo (sawg), whole history', site],
      ['  Pictures in the game', total(imgs), imgs ? Object.keys(imgs).length : 0],
      ...(cfg ? [['Saves repo (' + cfg.repo + ')', savesRepo], ['  Pictures waiting for approval', total(pendingPics), pendingPics ? Object.keys(pendingPics).length : 0]] : []),
    ];
    if (!$('#st-total')) return; // left the admin page meanwhile
    const used = (site || 0) + (savesRepo || 0);
    $('#st-total').textContent = `Total used: ${formatSize(used)} (${(used / GB).toFixed(3)} GB) · about 1 GB per repo is fine`;
    $('#st-bar').style.width = Math.min(100, ((Math.max(site || 0, savesRepo || 0)) / GB) * 100) + '%';
    $('#st-list').replaceChildren(...rows.flatMap(([label, bytes, count]) => [
      el('dt', { textContent: label + (count ? ` (${count} files)` : '') }),
      el('dd', { textContent: bytes == null ? '—' : formatSize(bytes) }),
    ]));
  }

  // ----- groups -----

  $('#g-form').onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim().slice(0, 40);
    if (!name) return;
    doSave(e.target.querySelector('[type=submit]'), async () => {
      await updateRepoJson('groups', (all) => {
        if (withDefaultGroup(all).some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a group called "${name}".`);
        if (!all.some((g) => g && g.id === DEFAULT_GROUP)) all.unshift({ id: DEFAULT_GROUP, name: 'Default' });
        all.push({ id: 'g-' + Date.now().toString(36), name, createdAt: new Date().toISOString().slice(0, 10) });
      }, `Add group ${name}`);
      e.target.name.value = '';
      saved(`Group "${name}" added. Move players into it in the Users tab.`);
      refresh();
    });
  };

  function renderGroups(groups, users, saves) {
    const list = $('#g-list');
    list.replaceChildren();
    groups.forEach((g) => {
      const members = users.filter((u) => groupOf(u, groups) === g.id);
      const rename = el('button', { textContent: 'Rename' });
      rename.onclick = () => {
        const name = (prompt('New name for this group:', g.name) || '').trim().slice(0, 40);
        if (!name || name === g.name) return;
        doSave(rename, async () => {
          await updateRepoJson('groups', (all) => {
            if (withDefaultGroup(all).some((x) => x.id !== g.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a group called "${name}".`);
            const x = all.find((y) => y && y.id === g.id);
            if (x) x.name = name;
            else all.unshift({ id: g.id, name }); // the default group, named for the first time
          }, `Rename group ${g.name} to ${name}`);
          saved('Group renamed.');
          refresh();
        });
      };
      const row = el('div', { className: 'row' }, rename);
      if (g.id !== DEFAULT_GROUP) {
        const del = el('button', { textContent: 'Delete', className: 'link' });
        del.onclick = () => {
          if (!confirm(`Delete the group "${g.name}"?` + (members.length ? ` Its ${members.length} player(s) move to the Default group.` : ''))) return;
          doSave(del, async () => {
            if (members.length) {
              await updateRepoJson('users', (all) => all.forEach((u) => {
                if (u.group === g.id) u.group = DEFAULT_GROUP;
              }), `Move players of group ${g.name} to Default`);
            }
            // Puzzles only for this group go to Default, where its players went.
            if (lastPuzzles.some((x) => Array.isArray(x.groups) && x.groups.includes(g.id))) {
              await updateRepoJson('puzzles', (all) => all.forEach((x) => {
                if (!Array.isArray(x.groups) || !x.groups.includes(g.id)) return;
                x.groups = x.groups.filter((id) => id !== g.id);
                if (!x.groups.includes(DEFAULT_GROUP)) x.groups.push(DEFAULT_GROUP);
              }), `Show puzzles of group ${g.name} to Default`);
            }
            await updateRepoJson('groups', (all) => {
              const i = all.findIndex((y) => y && y.id === g.id);
              if (i >= 0) all.splice(i, 1);
            }, `Delete group ${g.name}`);
            saved('Group deleted.');
            refresh();
          });
        };
        row.append(del);
      }
      list.append(el('li', {},
        el('strong', { textContent: g.name }), ' ',
        g.id === DEFAULT_GROUP ? el('span', { className: 'status approved', textContent: 'default' }) : null,
        el('div', { className: 'meta', textContent: `${members.length} player${members.length === 1 ? '' : 's'}` + (members.length ? ': ' + members.map((u) => displayNameOf(u.username, users, saves)).join(', ') : '') }),
        row));
    });
  }

  function groupPicker(u, groups, name) {
    const pick = el('select', { title: 'Group' },
      ...groups.map((g) => el('option', { value: g.id, textContent: g.name, selected: g.id === groupOf(u, groups) })));
    // Not doSave: that would replace the dropdown's options with "Saving…".
    pick.onchange = async () => {
      const to = groups.find((g) => g.id === pick.value);
      pick.disabled = true;
      try {
        await updateRepoJson('users', (all) => {
          const x = all.find((y) => y.username === u.username);
          if (x) x.group = pick.value;
        }, `Move user ${u.username} to group ${to ? to.name : pick.value}`);
        saved(`${name} is now in ${to ? to.name : 'that group'}.`);
      } catch (e) {
        alert(e.message);
      }
      refresh();
    };
    return el('label', { className: 'inline small' }, 'Group: ', pick);
  }

  function renderUsers(users, saves, puzzles, signups, cfg, groups) {
    const list = $('#a-users');
    list.replaceChildren();
    const waiting = Object.values(signups || {}).sort((x, y) => String(x.requestedAt).localeCompare(String(y.requestedAt)));
    $('#signup-count').textContent = waiting.length || '';
    if (waiting.length) list.append(el('li', { className: 'empty', textContent: `🙋 ${waiting.length} waiting for you to activate:` }));
    waiting.forEach((u) => list.append(signupCard(u, cfg)));
    [...users].reverse().forEach((u) => {
      const active = u.status === 'active';
      const row = el('div', { className: 'row' });
      if (!u.admin) {
        const toggle = el('button', { textContent: active ? 'Deactivate' : 'Activate', className: active ? 'bad' : 'ok' });
        toggle.onclick = () => doSave(toggle, async () => {
          await updateRepoJson('users', (all) => {
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
            await updateRepoJson('users', (all) => {
              const i = all.findIndex((y) => y.username === u.username);
              if (i >= 0) all.splice(i, 1);
            }, `Delete user ${u.username}`);
            saved(`${u.displayName} was deleted.`);
            refresh();
          });
        };
        row.append(toggle, del);
      }
      row.append(groupPicker(u, groups, displayNameOf(u.username, users, saves)));
      list.append(el('li', {},
        el('strong', { textContent: displayNameOf(u.username, users, saves) }), ' ',
        el('span', { className: 'status ' + (active ? 'approved' : 'rejected'), textContent: u.admin ? 'admin' : u.status }),
        el('div', { className: 'meta', textContent: `@${u.username} · joined ${u.joinedAt || ''} · ${puzzlesBy(u.username, puzzles, users).length} puzzles` + (saves ? ` · ${((saves[u.username] || {}).solved || []).length} solved · 💎 ${savedJewels(saves[u.username], puzzlesBy(u.username, puzzles, users).length)}` : '') }),
        row));
    });
  }

  // Which groups see a puzzle. All groups unless some are picked.
  function showToControls(p, groups) {
    const chosen = Array.isArray(p.groups) ? p.groups.filter((id) => groups.some((g) => g.id === id)) : [];
    const names = chosen.map((id) => groups.find((g) => g.id === id).name);
    const summary = el('summary', { textContent: '👥 Shown to: ' + (chosen.length ? names.join(', ') : 'All groups') });
    const all = el('input', { type: 'checkbox', checked: !chosen.length });
    const boxes = groups.map((g) => el('input', { type: 'checkbox', value: g.id, checked: chosen.includes(g.id) }));
    all.onchange = () => all.checked && boxes.forEach((b) => (b.checked = false));
    boxes.forEach((b) => (b.onchange = () => (all.checked = !boxes.some((x) => x.checked))));
    const save = el('button', { className: 'primary', textContent: 'Save' });
    save.onclick = () => doSave(save, async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      await updateRepoJson('puzzles', (list) => {
        const x = list.find((y) => y.id === p.id);
        if (!x) throw new Error('That puzzle is no longer in the game.');
        if (ids.length) x.groups = ids;
        else delete x.groups;
      }, `Show puzzle ${p.id} to ${ids.length ? groups.filter((g) => ids.includes(g.id)).map((g) => g.name).join(', ') : 'all groups'}`);
      saved(ids.length ? 'Saved. Only the chosen groups see this puzzle.' : 'Saved. All groups see this puzzle.');
      refresh();
    });
    return el('details', { className: 'show-to' }, summary,
      el('label', { className: 'inline' }, all, ' All groups'),
      ...groups.map((g, i) => el('label', { className: 'inline' }, boxes[i], ' ' + g.name)),
      el('div', { className: 'row' }, save));
  }

  function renderPuzzles(puzzles, users, saves, imgs = {}, groups = withDefaultGroup([])) {
    const list = $('#a-puzzles');
    list.replaceChildren();
    if (!puzzles.length) list.append(el('li', { className: 'empty', textContent: 'No puzzles yet.' }));
    puzzles.forEach((p, n) => {
      const del = el('button', { textContent: 'Delete', className: 'link' });
      del.onclick = () => {
        if (!confirm('Delete this puzzle from the game?')) return;
        doSave(del, async () => {
          await updateRepoJson('puzzles', (all) => {
            const i = all.findIndex((y) => y.id === p.id);
            if (i >= 0) all.splice(i, 1);
          }, `Delete puzzle ${p.id}`);
          saved('Puzzle deleted.');
          refresh();
        });
      };
      list.append(el('li', {},
        el('div', { textContent: `${n + 1}. ${p.question}`, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
        p.image ? el('img', { src: p.image, alt: '' }) : null,
        p.image ? el('div', { className: 'size', textContent: `Question picture · ${formatSize(imgs[p.image])}` }) : null,
        p.answerImage ? el('img', { src: p.answerImage, alt: '' }) : null,
        p.answerImage ? el('div', { className: 'size', textContent: `Answer picture · ${formatSize(imgs[p.answerImage])}` }) : null,
        p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
      p.type === 'photo' ? el('div', { className: 'meta', textContent: `🧩 Arrange the photo · ${(p.grid === 3 ? 9 : 4)} pieces` }) : null,
      p.type === 'word' ? el('div', { className: 'meta', textContent: `🔤 Guess the word · ${p.length} letters · reward ${p.length - 1} jewels` }) : null,
        el('div', { className: 'meta', textContent: `By ${puzzleAuthor(p, users, saves)} · ${p.addedAt || ''}` }),
        showToControls(p, groups),
        el('div', { className: 'row' }, el('button', { textContent: 'Edit', onclick: () => submit(p) }), del),
        moveControls(p, n, puzzles.length)));
    });
  }

  // Change the order of the game. Players keep their progress: solved
  // puzzles stay solved, and they get the first unsolved one in the new order.
  function moveControls(p, n, count) {
    const move = (button, to) => doSave(button, async () => {
      await updateRepoJson('puzzles', (all) => {
        const i = all.findIndex((y) => y.id === p.id);
        if (i < 0) throw new Error('That puzzle is no longer in the game.');
        const [x] = all.splice(i, 1);
        all.splice(Math.max(0, Math.min(to, all.length)), 0, x);
      }, `Move puzzle ${p.id} to position ${to + 1}`);
      saved(`Moved to position ${to + 1}.`);
      refresh();
    });
    const up = el('button', { textContent: '↑', title: 'Move up', disabled: n === 0 });
    up.onclick = () => move(up, n - 1);
    const down = el('button', { textContent: '↓', title: 'Move down', disabled: n === count - 1 });
    down.onclick = () => move(down, n + 1);
    const pick = el('select', { title: 'Move to position' },
      ...Array.from({ length: count }, (_, i) => el('option', { value: i, textContent: `Position ${i + 1}`, selected: i === n })));
    pick.onchange = () => move(pick, Number(pick.value));
    return el('div', { className: 'row move' }, up, down, pick);
  }

  // ----- saving progress -----

  function renderSaves(settings, cfg, saves) {
    const status = $('#saves-status');
    if (settings.savesRepo) $('#saves-repo').value = settings.savesRepo;
    status.textContent = !cfg
      ? 'Not set up yet: progress is saved on each device only.'
      : saves
        ? `✅ Saving to ${cfg.repo}.`
        : `⚠️ Can't reach ${cfg.repo} with the saved key. It may have expired: paste a new one.`;

    $('#saves-save').onclick = () => doSave($('#saves-save'), async () => {
      try {
        status.textContent = '⏳ Checking the key…';
        await setUpSaves();
      } catch (e) {
        status.textContent = '❌ ' + e.message;
        throw e;
      }
    });

    async function setUpSaves() {
      const repo = $('#saves-repo').value.trim();
      const key = $('#saves-key').value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Saves repo should look like SaudAlomari/sawg-saves');
      if (`${repo}`.toLowerCase() === `${SAVES_SITE_REPO}`.toLowerCase()) throw new Error('Use a separate repo for saves, not the site repo.');
      if (!key) throw new Error('Paste the saves key.');
      const headers = { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' };
      const r1 = await fetch(`https://api.github.com/repos/${repo}`, { headers, cache: 'no-store' });
      if (!r1.ok) throw new Error(`That key can't open ${repo}. Check the repo name and that the key has access to it.`);
      const info = await r1.json();
      if (info.permissions && !info.permissions.push) throw new Error('That key can only read. Set Contents to "Read and write".');
      // Make sure the key can't change the site repo. (The repo's "permissions"
      // field shows the owner's rights, not the key's.) So we try a save that
      // can't succeed: it names a wrong version of settings.json. A key with
      // write access gets "409 conflict"; any other key is refused (403/404).
      // Nothing is changed either way.
      const probe = await fetch(`${GH_API}/contents/data/settings.json`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'key check', content: btoa('{}'), sha: '0'.repeat(40), branch: SAWG.branch }),
      });
      if (probe.ok || probe.status === 409 || probe.status === 422) {
        throw new Error('That key can also change the site repo. Make a key that only has access to the saves repo.');
      }
      // Make sure usersSavedData.json exists.
      status.textContent = `⏳ Creating usersSavedData.json in ${repo}…`;
      const testCfg = { repo, key };
      try {
        await updateSaves(testCfg, () => {}, 'Set up saves');
      } catch (e) {
        throw new Error(`Couldn't create usersSavedData.json in ${repo} (${e.message}). Check the key has Contents: Read and write.`);
      }
      status.textContent = '⏳ Saving the settings…';
      await updateRepoJson('settings', (s) => {
        s.savesRepo = repo;
        s.saveKey = hideKey(key);
      }, 'Set up saving progress');
      $('#saves-key').value = '';
      saved('Saving is set up! Players will start saving in about a minute.');
      refresh();
    }
  }

  // ----- sign-ups waiting for approval -----

  function signupCard(u, cfg) {
    const ok = el('button', { className: 'primary', textContent: 'Activate' });
    ok.onclick = () => doSave(ok, async () => {
      await updateRepoJson('users', (all) => {
        if (all.some((x) => x.username === u.username)) throw new Error(`The username "${u.username}" is already taken.`);
        all.push({
          username: normalize(u.username),
          displayName: String(u.displayName || u.username).slice(0, 40),
          salt: u.salt,
          hash: u.hash,
          status: 'active',
          joinedAt: new Date().toISOString().slice(0, 10),
          group: DEFAULT_GROUP,
        });
      }, `Activate user ${u.username}`);
      await updateSaves(cfg, (all) => delete all[u.username], `Done with sign-up ${u.username}`, SIGNUPS_FILE);
      saved(`${u.displayName} is activated! They can sign in in about a minute.`);
      refresh();
    });
    const no = el('button', { className: 'bad', textContent: 'Reject' });
    no.onclick = () => {
      if (!confirm(`Reject ${u.displayName}'s sign-up?`)) return;
      doSave(no, async () => {
        await updateSaves(cfg, (all) => delete all[u.username], `Reject sign-up ${u.username}`, SIGNUPS_FILE);
        saved('Sign-up rejected.');
        refresh();
      });
    };
    return el('li', { className: 'waiting' },
      el('strong', { textContent: u.displayName }), ' ',
      el('span', { className: 'status pending', textContent: 'waiting' }),
      el('div', { className: 'meta', textContent: `@${u.username} · asked ${String(u.requestedAt || '').slice(0, 10)}` }),
      el('div', { className: 'row' }, ok, no));
  }

  function pictureInput() {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    const img = el('img', { hidden: true, className: 'preview', alt: '' });
    const size = el('div', { className: 'size' });
    const pic = { input, img, size, note: el('div', { className: 'meta' }), pending: null, pendingPath: null };
    input.onchange = () => {
      const f = input.files[0] || pic.pending;
      img.hidden = !f;
      if (f) img.src = URL.createObjectURL(f);
      size.textContent = f ? `Size: ${formatSize(f.size)}` : '';
    };
    return pic;
  }

  function checkPicture(f, what) {
    if (!f) return null;
    if (f.size > 2 * 1024 * 1024) throw new Error(`The ${what} must be under 2 MB.`);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[f.type];
    if (!ext) throw new Error(`The ${what} must be PNG, JPG, GIF or WEBP.`);
    return ext;
  }


  // A puzzle waiting for approval: from the pending list (or an old puzzle code).
  function puzzleCard(p, fromPending) {
    const cfg = lastCfg || savesConfig(settings);
    const current = p.edits ? lastPuzzles.find((x) => x.id === p.edits) : null;
    const remove = p.remove || {};
    const images = p.images && typeof p.images === 'object' ? p.images : {};
    const pendingPaths = Object.values(images).filter((x) => typeof x === 'string' && /^pending\/[\w.-]+$/.test(x));
    const hints = puzzleHints(p).slice(0, MAX_HINTS);
    const q = pictureInput();
    const a = pictureInput();

    // Pictures the player uploaded: show them, and use them unless replaced.
    for (const [key, pic] of [['q', q], ['a', a]]) {
      const path = images[key];
      if (!pendingPaths.includes(path)) {
        const now = current && (key === 'q' ? current.image : current.answerImage);
        if (now && remove[key]) pic.note.textContent = '🗑️ They asked to remove the current picture. You can attach one instead:';
        else if (now) {
          pic.note.textContent = 'No change: keeps the current picture (choose a file to replace it):';
          pictureSize(now).then((n) => !pic.input.files[0] && (pic.size.textContent = `Size: ${formatSize(n)}`));
          pic.img.src = now;
          pic.img.hidden = false;
        } else pic.note.textContent = 'None. You can attach one:';
        continue;
      }
      pic.pendingPath = path;
      pic.note.textContent = '⏳ Loading their picture…';
      if (!cfg) {
        pic.note.textContent = "⚠️ Saving progress is not set up, so their picture can't be loaded.";
        continue;
      }
      savesGetBlob(cfg, path).then((blob) => {
        pic.pending = blob;
        pic.note.textContent = 'Their picture (choose a file to replace it):';
        if (!pic.input.files[0]) pic.size.textContent = `Size: ${formatSize(blob.size)}`;
        if (!pic.input.files[0]) {
          pic.img.src = URL.createObjectURL(blob);
          pic.img.hidden = false;
        }
      }).catch(() => (pic.note.textContent = '⚠️ Their picture could not be loaded. You can attach one instead.'));
    }

    const removePending = async () => {
      if (!cfg) return;
      await Promise.all(pendingPaths.map((x) => savesDeleteFile(cfg, x, 'Remove puzzle picture').catch(() => {})));
      if (fromPending) await updateSaves(cfg, (all) => delete all[p.key || p.id], `Done with puzzle ${p.key || p.id}`, PENDING_FILE);
    };

    const btn = el('button', { className: 'primary', textContent: p.edits ? 'Approve the changes' : 'Approve and add to the game' });
    btn.onclick = () => doSave(btn, async () => {
      const pick = (pic, key, what) => {
        const f = pic.input.files[0];
        if (f) return { bytes: f.arrayBuffer(), ext: checkPicture(f, what) };
        if (pic.pending) return { bytes: pic.pending.arrayBuffer(), ext: pic.pendingPath.split('.').pop() };
        if (pic.pendingPath) throw new Error(`Their ${what} hasn't loaded yet. Wait a moment, or attach one yourself.`);
        if (p.edits) return remove[key] ? null : undefined;
        return null;
      };
      await savePuzzle(p, p.answers, { q: pick(q, 'q', 'question picture'), a: pick(a, 'a', 'answer picture') });
      await removePending();
      saved(p.edits ? 'Changes approved! They show in the game in about a minute.'
        : `Puzzle added! It shows in the game in about a minute.${p.by ? ` ${p.author} gets 💎 ${PUZZLE_GIFT}.` : ''}`);
      refresh();
    });

    const reject = el('button', { className: 'bad', textContent: 'Reject' });
    reject.onclick = () => {
      if (!confirm(p.edits ? 'Reject these changes? The puzzle stays as it is.' : 'Reject this puzzle? It and its pictures will be deleted.')) return;
      doSave(reject, async () => {
        await removePending();
        saved(p.edits ? 'Changes rejected.' : 'Puzzle rejected.');
        refresh();
      });
    };

    return el('li', {},
      el('div', { className: 'meta', textContent: `${p.edits ? '✏️ Changes to a puzzle' : 'Puzzle'} from ${p.author}${p.by ? ' (@' + p.by + ')' : ''}${p.submittedAt ? ' · ' + p.submittedAt.slice(0, 10) : ''}` }),
      p.edits ? el('div', { className: 'meta', textContent: current ? `Now: ${current.question}` : '⚠️ That puzzle is no longer in the game.', dir: 'auto' }) : null,
      el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
      p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
      p.type === 'photo' ? el('div', { className: 'meta', textContent: `🧩 Arrange the photo · ${(p.grid === 3 ? 9 : 4)} pieces` }) : null,
      p.type === 'word' ? el('div', { className: 'meta', textContent: `🔤 Guess the word · ${p.length} letters · reward ${p.length - 1} jewels` }) : null,
      p.type === 'photo' ? null : el('div', { className: 'meta', textContent: !p.answers.length ? 'Answers: no change' : (p.answers.length > 1 ? 'Accepted answers: ' : 'Answer: ') + p.answers.join(' | ') }),
      ...hints.map((h, i) => el('div', { className: 'meta', textContent: `Hint ${i + 1} (${h.size === 'small' ? 'small, 2 💎' : 'big, 4 💎'}): ${h.text}` })),
      el('h3', { textContent: 'Question picture' }), q.note, q.input, q.img, q.size,
      el('h3', { textContent: 'Answer picture (shown after a correct answer)' }), a.note, a.input, a.img, a.size,
      el('div', { className: 'row' }, btn, reject));
  }

  function renderPending(pending) {
    const list = $('#a-pending');
    list.replaceChildren();
    const items = Object.entries(pending || {}).map(([key, x]) => ({ ...x, key })).sort((x, y) => String(x.submittedAt).localeCompare(String(y.submittedAt)));
    $('#pending-count').textContent = items.length || '';
    if (!pending) list.append(el('li', { className: 'empty', textContent: 'Set up saving progress (below) so players can send puzzles.' }));
    else if (!items.length) list.append(el('li', { className: 'empty', textContent: 'No puzzles waiting. 🎉' }));
    items.forEach((p) => {
      let answers = [];
      try { if (p.answersHidden) answers = JSON.parse(revealKey(p.answersHidden)); } catch {}
      list.append(puzzleCard({ ...p, answers }, true));
    });
  }

  refresh();
}

function keyView(app) {
  app.replaceChildren(document.getElementById('t-admin-key').content.cloneNode(true));
  fillKeySteps(app);
  const form = app.querySelector('#key-form');
  const err = form.querySelector('.error');
  form.onsubmit = async (e) => {
    e.preventDefault();
    showMsg(err);
    const key = form.token.value.trim();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await checkKey(key);
      setKey(key);
      adminView(app);
    } catch (e2) {
      showMsg(err, e2.message);
    } finally {
      btn.disabled = false;
    }
  };
}
