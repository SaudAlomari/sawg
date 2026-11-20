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
    setTimeout(() => showMsg($('#saved')), 6000);
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

  async function refresh() {
    try {
      const [{ data: users }, { data: puzzles }, { data: settings }] = await Promise.all([
        readRepoJson('users'), readRepoJson('puzzles'), readRepoJson('settings'),
      ]);
      const cfg = savesConfig(settings);
      lastCfg = cfg;
      const saves = cfg ? await readSaves(cfg).then((r) => r.data).catch(() => null) : null;
      renderUsers(users, saves, puzzles);
      renderPuzzles(puzzles, users, saves);
      renderSaves(settings, cfg, saves);
    } catch (e) {
      $('#a-users').replaceChildren(el('li', { className: 'error', textContent: e.message }));
    }
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

  function renderPuzzles(puzzles, users, saves) {
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
        p.answerImage ? el('div', { className: 'meta', textContent: 'Answer picture:' }) : null,
        p.answerImage ? el('img', { src: p.answerImage, alt: '' }) : null,
        p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
        el('div', { className: 'meta', textContent: `By ${puzzleAuthor(p, users, saves)} · ${p.addedAt || ''}` }),
        el('div', { className: 'row' }, del)));
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
    else previewPuzzle(parsed.data);
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
    const pic = { input, img, note: el('div', { className: 'meta' }), pending: null, pendingPath: null };
    input.onchange = () => {
      const f = input.files[0] || pic.pending;
      img.hidden = !f;
      if (f) img.src = URL.createObjectURL(f);
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

  async function uploadPicture(buf, path, what, id) {
    const res = await putFile(path, new Uint8Array(buf), `Add ${what} for ${id}`);
    if (!res.ok) throw new Error(`Could not upload the ${what} (${res.status}).`);
    return path;
  }

  function previewPuzzle(p) {
    const cfg = lastCfg || savesConfig(settings);
    const pending = p.images && typeof p.images === 'object' ? p.images : {};
    const pendingPaths = Object.values(pending).filter((x) => typeof x === 'string' && /^pending\/[\w.-]+$/.test(x));
    const q = pictureInput();
    const a = pictureInput();

    // Pictures the player uploaded: show them, and use them unless replaced.
    for (const [key, pic] of [['q', q], ['a', a]]) {
      const path = pending[key];
      if (!pendingPaths.includes(path)) continue;
      pic.pendingPath = path;
      pic.note.textContent = '⏳ Loading their picture…';
      if (!cfg) {
        pic.note.textContent = '⚠️ Saving progress is not set up, so their picture can\'t be loaded.';
        continue;
      }
      savesGetBlob(cfg, path).then((blob) => {
        pic.pending = blob;
        pic.note.textContent = 'Their picture (choose a file to replace it):';
        if (!pic.input.files[0]) {
          pic.img.src = URL.createObjectURL(blob);
          pic.img.hidden = false;
        }
      }).catch(() => (pic.note.textContent = '⚠️ Their picture could not be loaded. You can attach one instead.'));
    }

    const removePending = () => cfg && Promise.all(pendingPaths.map((x) => savesDeleteFile(cfg, x, 'Remove puzzle picture').catch(() => {})));

    const btn = el('button', { className: 'primary', textContent: 'Approve and add to the game' });
    btn.onclick = () => doSave(btn, async () => {
      const id = 'p-' + Date.now().toString(36);
      const pick = (pic, what) => {
        const f = pic.input.files[0];
        if (f) return { bytes: f.arrayBuffer(), ext: checkPicture(f, what) };
        if (pic.pending) return { bytes: pic.pending.arrayBuffer(), ext: pic.pendingPath.split('.').pop() };
        if (pic.pendingPath) throw new Error(`Their ${what} hasn't loaded yet. Wait a moment, or attach one yourself.`);
        return null;
      };
      const qp = pick(q, 'question picture');
      const ap = pick(a, 'answer picture');
      const image = qp ? await uploadPicture(await qp.bytes, `images/${id}.${qp.ext}`, 'question picture', id) : null;
      const answerImage = ap ? await uploadPicture(await ap.bytes, `images/${id}-answer.${ap.ext}`, 'answer picture', id) : null;
      const answerHashes = await Promise.all(p.answers.map((x) => hashAnswer(id, x)));
      await updateRepoJson('puzzles', (all) => {
        all.push({
          id,
          question: String(p.question).slice(0, 1000),
          type: p.type === 'choice' ? 'choice' : 'text',
          options: p.type === 'choice' ? p.options.slice(0, 6) : [],
          answerHashes,
          hint: String(p.hint || '').slice(0, 300),
          image,
          answerImage,
          author: String(p.author || 'Someone').slice(0, 40),
          ...(p.by ? { by: String(p.by).slice(0, 20) } : {}),
          addedAt: new Date().toISOString().slice(0, 10),
        });
      }, `Add puzzle ${id} by ${p.by || p.author}`);
      await removePending();
      clearCode();
      saved(`Puzzle added! It shows in the game in about a minute.${p.by ? ` ${p.author} gets 💎 ${PUZZLE_GIFT}.` : ''}`);
      refresh();
    });

    const reject = el('button', { className: 'bad', textContent: 'Reject' });
    reject.onclick = () => {
      if (!confirm('Reject this puzzle? Their pictures will be deleted.')) return;
      doSave(reject, async () => {
        await removePending();
        clearCode();
        saved('Puzzle rejected.');
      });
    };

    $('#preview').append(el('div', { className: 'list' }, el('li', {},
      el('div', { className: 'meta', textContent: `Puzzle from ${p.author}${p.by ? ' (@' + p.by + ')' : ''}` }),
      el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
      p.type === 'choice' ? el('div', { className: 'meta', textContent: 'Options: ' + p.options.join(' / ') }) : null,
      el('div', { className: 'meta', textContent: (p.answers.length > 1 ? 'Accepted answers: ' : 'Answer: ') + p.answers.join(' | ') }),
      p.hint ? el('div', { className: 'meta', textContent: 'Hint: ' + p.hint }) : null,
      el('h3', { textContent: 'Question picture' }), q.note,
      el('label', {}, q.pendingPath ? '' : (p.hasImage ? 'They said there is one, attach it here:' : 'Optional:'), q.input),
      q.img,
      el('h3', { textContent: 'Answer picture (shown after a correct answer)' }), a.note,
      el('label', {}, a.pendingPath ? '' : (p.hasAnswerImage ? 'They said there is one, attach it here:' : 'Optional:'), a.input),
      a.img,
      el('div', { className: 'row' }, btn, reject))));
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
