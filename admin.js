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
  const answerHashes = answers.length ? await Promise.all(answers.map((x) => hashAnswer(id, x))) : null;
  if (!editing && !answerHashes) throw new Error('This puzzle has no answer.');
  const fields = {
    question: String(p.question).slice(0, 1000),
    type: p.type === 'choice' ? 'choice' : 'text',
    options: p.type === 'choice' ? (p.options || []).slice(0, 6) : [],
    hints: puzzleHints(p).slice(0, MAX_HINTS).map((h) => ({ text: String(h.text).slice(0, 300), size: h.size === 'small' ? 'small' : 'big' })),
  };
  await updateRepoJson('puzzles', (all) => {
    if (editing) {
      const x = all.find((y) => y.id === id);
      if (!x) throw new Error('That puzzle is no longer in the game.');
      Object.assign(x, fields);
      delete x.hint;
      if (answerHashes) x.answerHashes = answerHashes;
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

  async function refresh() {
    try {
      const [{ data: users }, { data: puzzles }, { data: settings }] = await Promise.all([
        readRepoJson('users'), readRepoJson('puzzles'), readRepoJson('settings'),
      ]);
      const cfg = savesConfig(settings);
      lastCfg = cfg;
      lastPuzzles = puzzles;
      const saves = cfg ? await readSaves(cfg).then((r) => r.data).catch(() => null) : null;
      if (!$('#a-users')) return; // left the admin page meanwhile
      renderUsers(users, saves, puzzles);
      const imgs = await listFolder((p) => gh(`${p}?ref=${SAWG.branch}`), 'images');
      if (!$('#a-puzzles')) return;
      renderPuzzles(puzzles, users, saves, imgs || {});
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

  function renderUsers(users, saves, puzzles) {
    const list = $('#a-users');
    list.replaceChildren();
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
      list.append(el('li', {},
        el('strong', { textContent: displayNameOf(u.username, users, saves) }), ' ',
        el('span', { className: 'status ' + (active ? 'approved' : 'rejected'), textContent: u.admin ? 'admin' : u.status }),
        el('div', { className: 'meta', textContent: `@${u.username} · joined ${u.joinedAt || ''} · ${puzzlesBy(u.username, puzzles, users).length} puzzles` + (saves ? ` · ${((saves[u.username] || {}).solved || []).length} solved · 💎 ${savedJewels(saves[u.username], puzzlesBy(u.username, puzzles, users).length)}` : '') }),
        row));
    });
  }

  function renderPuzzles(puzzles, users, saves, imgs = {}) {
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
        el('div', { className: 'meta', textContent: `By ${puzzleAuthor(p, users, saves)} · ${p.addedAt || ''}` }),
        el('div', { className: 'row' }, el('button', { textContent: 'Edit', onclick: () => submit(p) }), del)));
    });
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

  // ----- pasted codes -----

  const clearCode = () => {
    $('#code').value = '';
    $('#preview').replaceChildren();
  };

  $('#code').oninput = () => {
    const err = $('#code-error');
    $('#preview').replaceChildren();
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
    else $('#preview').append(el('div', { className: 'list' }, puzzleCard(parsed.data, false)));
  };

  function previewUser(u) {
    const btn = el('button', { className: 'primary', textContent: `Activate ${u.displayName}` });
    btn.onclick = () => doSave(btn, async () => {
      await updateRepoJson('users', (all) => {
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
      el('div', { textContent: 'Sign-up request', className: 'meta' }),
      el('strong', { textContent: u.displayName }),
      el('div', { className: 'meta', textContent: `Username: @${u.username}` }),
      el('div', { className: 'row' }, btn))));
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
      if (!fromPending) clearCode();
      saved(p.edits ? 'Changes approved! They show in the game in about a minute.'
        : `Puzzle added! It shows in the game in about a minute.${p.by ? ` ${p.author} gets 💎 ${PUZZLE_GIFT}.` : ''}`);
      refresh();
    });

    const reject = el('button', { className: 'bad', textContent: 'Reject' });
    reject.onclick = () => {
      if (!confirm(p.edits ? 'Reject these changes? The puzzle stays as it is.' : 'Reject this puzzle? It and its pictures will be deleted.')) return;
      doSave(reject, async () => {
        await removePending();
        if (!fromPending) clearCode();
        saved(p.edits ? 'Changes rejected.' : 'Puzzle rejected.');
        refresh();
      });
    };

    return el('li', {},
      el('div', { className: 'meta', textContent: `${p.edits ? '✏️ Changes to a puzzle' : 'Puzzle'} from ${p.author}${p.by ? ' (@' + p.by + ')' : ''}${p.submittedAt ? ' · ' + p.submittedAt.slice(0, 10) : ''}` }),
      p.edits ? el('div', { className: 'meta', textContent: current ? `Now: ${current.question}` : '⚠️ That puzzle is no longer in the game.', dir: 'auto' }) : null,
      el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
      p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
      el('div', { className: 'meta', textContent: !p.answers.length ? 'Answers: no change' : (p.answers.length > 1 ? 'Accepted answers: ' : 'Answer: ') + p.answers.join(' | ') }),
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
