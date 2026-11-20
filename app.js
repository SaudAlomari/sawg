'use strict';
// The player site. Reads data/users.json and data/puzzles.json from the repo.
// Sign-ups and puzzles become codes that players send to the admin.

const app = document.getElementById('app');
let users = [];
let puzzles = [];
let me = null;
let settings = {};
let saves = {}; // usersSavedData.json: progress and profile names

function mount(id) {
  app.replaceChildren(document.getElementById(id).content.cloneNode(true));
}

// ---------- progress ----------
// Kept on this device, and also saved in usersSavedData.json (see saves.js)
// once the admin has set up saving.

function progressKey() {
  return 'sawg-progress-' + me.username;
}
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(progressKey()));
    if (p && Array.isArray(p.solved) && Array.isArray(p.skipped)) {
      if (!Array.isArray(p.hinted)) p.hinted = [];
      return p;
    }
  } catch {}
  return { solved: [], skipped: [], hinted: [] };
}

// Jewels: +2 for each solved puzzle, minus what hints cost (2 small, 4 big),
// +1 for each of your puzzles that is in the game.
const JEWELS_PER_SOLVE = 2;
const MAX_ALTS = 5; // alternative answers on top of the main one
function jewels(progress) {
  return progress.solved.length * JEWELS_PER_SOLVE - hintSpent(progress.hinted)
    + puzzlesBy(me.username, puzzles, users).length * PUZZLE_GIFT;
}
function saveLocal(p) {
  try { localStorage.setItem(progressKey(), JSON.stringify(p)); } catch {}
}
function saveProgress(p) {
  saveLocal(p);
  uploadProgress(p);
}

// ---------- saving to the account ----------

// Saves run one at a time; if more come in meanwhile, only the newest is sent.
let uploading = false;
let pending = null;
async function uploadProgress(p) {
  const cfg = savesConfig(settings);
  if (!cfg || !me) return;
  pending = { username: me.username, progress: { solved: p.solved, skipped: p.skipped, hinted: p.hinted } };
  if (uploading) return;
  uploading = true;
  while (pending) {
    const next = pending;
    pending = null;
    try {
      await updateSaves(cfg, (all) => {
        all[next.username] = { ...all[next.username], ...next.progress, updatedAt: new Date().toISOString() };
      }, `Progress: ${next.username}`);
      setSaveNote('ok');
    } catch {
      setSaveNote('fail');
    }
  }
  uploading = false;
}

// After signing in: the account's saved progress wins. If the account has
// none yet, this device's progress is uploaded.
async function syncDown() {
  const cfg = savesConfig(settings);
  if (!cfg || !me) return;
  try {
    const { data } = await readSaves(cfg);
    saves = data;
    me = { ...me, displayName: displayNameOf(me.username, users, saves) };
    const saved = data[me.username];
    if (saved) saveLocal({ solved: saved.solved || [], skipped: saved.skipped || [], hinted: saved.hinted || [] });
    else {
      const local = loadProgress();
      if (local.solved.length || local.skipped.length) await uploadProgress(local);
    }
  } catch {}
}

function setSaveNote(state) {
  const note = document.getElementById('save-note');
  if (!note) return;
  if (!savesConfig(settings)) note.textContent = 'يُحفظ تقدمك على هذا الجهاز.';
  else if (state === 'fail') note.textContent = '⚠️ تعذّر حفظ تقدمك في حسابك الآن. سنحاول مع إجابتك التالية.';
  else note.textContent = 'يُحفظ تقدمك وجواهرك في حسابك ✓';
}
function remember(username) {
  try {
    if (username) localStorage.setItem('sawg-user', username);
    else localStorage.removeItem('sawg-user');
  } catch {}
}

// ---------- routing ----------

const views = { play, submit, leaderboard: leaderboardView, profile, admin: () => adminView(app) };

function route() {
  const nav = document.getElementById('nav');
  if (!me) {
    nav.hidden = true;
    return authView();
  }
  nav.hidden = false;
  document.getElementById('whoami').textContent = me.displayName;
  document.getElementById('nav-admin').hidden = !me.admin;
  let page = location.hash.slice(1) || 'play';
  if (!views[page] || (page === 'admin' && !me.admin)) page = 'play';
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + page));
  views[page]();
}

window.addEventListener('hashchange', route);

document.getElementById('signout').onclick = () => {
  me = null;
  remember(null);
  location.hash = '';
  route();
};

// ---------- views ----------

function authView() {
  mount('t-auth');
  const form = app.querySelector('#auth-form');
  const err = form.querySelector('.error');
  const submitBtn = form.querySelector('[type=submit]');
  // Nobody has signed up yet: the first sign-up becomes the admin.
  const firstRun = users.length === 0;
  fillKeySteps(app);
  let mode = 'signin';
  const setMode = (m) => {
    mode = m;
    app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
    app.querySelectorAll('.signup-only').forEach((x) => (x.hidden = m !== 'signup' || firstRun));
    app.querySelectorAll('.signup-name').forEach((x) => (x.hidden = m !== 'signup'));
    app.querySelectorAll('.first-only').forEach((x) => (x.hidden = m !== 'signup' || !firstRun));
    form.token.required = m === 'signup' && firstRun;
    submitBtn.textContent = m === 'signup' ? (firstRun ? 'Create admin account' : 'إنشاء الحساب') : 'تسجيل الدخول';
    form.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    showMsg(err);
  };
  app.querySelectorAll('[data-tab]').forEach((btn) => (btn.onclick = () => setMode(btn.dataset.tab)));
  if (firstRun) setMode('signup');

  form.onsubmit = async (e) => {
    e.preventDefault();
    showMsg(err);
    const username = normalize(form.username.value);
    const password = form.password.value;
    submitBtn.disabled = true;
    try {
      if (mode === 'signin') {
        const user = users.find((u) => u.username === username);
        const ok = user && (await hashPassword(password, user.salt)) === user.hash;
        if (!ok) {
          return showMsg(err, 'اسم المستخدم أو كلمة المرور غير صحيحة. إذا سجّلت للتو، فربما لم يفعّل المشرف حسابك بعد.');
        }
        if (user.status !== 'active') return showMsg(err, 'حسابك غير مفعّل. تواصل مع المشرف.');
        me = user;
        remember(user.username);
        await syncDown();
        route();
      } else {
        if (!/^[a-z0-9_.-]{3,20}$/.test(username)) return showMsg(err, 'اسم المستخدم من ٣ إلى ٢٠ حرفًا إنجليزيًا أو أرقامًا (يُسمح بـ . و - و _).');
        if (password.length < 6) return showMsg(err, 'كلمة المرور يجب أن تكون ٦ أحرف على الأقل.');
        if (users.some((u) => u.username === username)) return showMsg(err, 'اسم المستخدم هذا مستخدم من قبل.');
        const salt = randomHex(16);
        if (firstRun) return await createAdmin(username, password, salt, err);
        const code = makeCode('USER', {
          username,
          displayName: form.displayName.value.trim().slice(0, 40) || username,
          salt,
          hash: await hashPassword(password, salt),
          requestedAt: new Date().toISOString(),
        });
        codeView({
          title: 'اقتربت!',
          text: 'أرسل رمز التسجيل هذا إلى المشرف. بعد أن يفعّل حسابك، ارجع وسجّل الدخول باسم المستخدم وكلمة المرور.',
          code,
          after: 'كلمة المرور مشفّرة داخل الرمز، لذلك إرساله آمن.',
          back: 'العودة لتسجيل الدخول',
          onBack: authView,
        });
      }
    } finally {
      submitBtn.disabled = false;
    }
  };
}

// The very first sign-up: saved straight into users.json as an active admin,
// using the GitHub key they paste (which is then kept on this device).
async function createAdmin(username, password, salt, err) {
  const form = app.querySelector('#auth-form');
  const key = form.token.value.trim();
  try {
    await checkKey(key);
    const user = {
      username,
      displayName: form.displayName.value.trim().slice(0, 40) || username,
      salt,
      hash: await hashPassword(password, salt),
      status: 'active',
      admin: true,
      joinedAt: new Date().toISOString().slice(0, 10),
    };
    await updateRepoJson('users', (all) => {
      if (all.length) throw new Error('Someone has already signed up as the admin. Please reload the page.');
      all.push(user);
    }, `Create admin account ${username}`, key);
    setKey(key);
    users.push(user);
    me = user;
    remember(user.username);
    location.hash = '#admin';
    route();
  } catch (e) {
    showMsg(err, e.message);
  }
}

function codeView({ title, text, code, after, back, onBack }) {
  mount('t-code');
  app.querySelector('#c-title').textContent = title;
  app.querySelector('#c-text').textContent = text;
  app.querySelector('#c-code').value = code;
  app.querySelector('#c-code').onclick = (e) => e.target.select();
  app.querySelector('#c-buttons').append(shareButtons(code));
  app.querySelector('#c-after').textContent = after;
  app.querySelector('#c-back').textContent = back;
  app.querySelector('#c-back').onclick = onBack;
}

function play() {
  mount('t-play');
  const $ = (s) => app.querySelector(s);
  const progress = loadProgress();
  const done = new Set([...progress.solved, ...progress.skipped]);
  const doneCount = puzzles.filter((p) => done.has(p.id)).length;
  const p = puzzles.find((x) => !done.has(x.id));

  $('#p-bar').style.width = puzzles.length ? (doneCount / puzzles.length) * 100 + '%' : '0';
  const showJewels = () => ($('#p-jewels').textContent = `💎 ${jewels(progress)}`);
  showJewels();
  setSaveNote('ok');

  if (!p) {
    $('#p-count').textContent = `${puzzles.length} من ${puzzles.length}`;
    $('#puzzle').hidden = true;
    $('#done').hidden = false;
    const solved = puzzles.filter((x) => progress.solved.includes(x.id)).length;
    $('#done-score').textContent = `حللت ${solved} من ${puzzles.length}.`;
    $('#done-jewels').textContent = `💎 ${jewels(progress)} جوهرة`;
    // Check for new puzzles; if some arrived, show the next one.
    const before = puzzles.length;
    refreshData().then(() => {
      if (puzzles.length !== before && (location.hash.slice(1) || 'play') === 'play' && app.querySelector('#done')) play();
    });
    return;
  }

  $('#p-count').textContent = `اللغز ${doneCount + 1} من ${puzzles.length}`;
  $('#p-author').textContent = 'من: ' + puzzleAuthor(p, users, saves);
  $('#p-question').textContent = p.question;
  if (p.image) {
    $('#p-image').src = p.image;
    $('#p-image').hidden = false;
  }

  let chosen = null;
  if (p.type === 'choice') {
    p.options.forEach((opt) => {
      const b = el('button', { type: 'button', textContent: opt });
      b.onclick = () => {
        chosen = opt;
        $('#p-options').querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === b));
      };
      $('#p-options').append(b);
    });
  } else {
    $('#p-text').hidden = false;
    $('#p-text').focus();
  }

  // Hints: each costs jewels (small 2, big 4) and stays open once bought.
  const hintsBox = $('#p-hints');
  const showHints = () => {
    hintsBox.replaceChildren();
    puzzleHints(p).forEach((h, i) => {
      const size = h.size === 'small' ? 'small' : 'big';
      const label = size === 'small' ? 'تلميح صغير' : 'تلميح كبير';
      const cost = HINT_COSTS[size];
      if (hintOpened(progress.hinted, p, i)) {
        hintsBox.append(el('p', { className: 'hint', textContent: `💡 ${label}: ${h.text}` }));
        return;
      }
      if (solvedNow) return;
      const b = el('button', { type: 'button', textContent: `💡 ${label} (${cost} 💎)` });
      if (jewels(progress) < cost) {
        b.disabled = true;
        b.title = `تحتاج ${cost} جواهر`;
      }
      b.onclick = () => {
        if (!confirm(`تستخدم ${cost} جواهر لرؤية ${label}؟`)) return;
        progress.hinted.push(hintKey(p, i, size));
        saveProgress(progress);
        showJewels();
        showHints();
      };
      hintsBox.append(b);
    });
  };
  let solvedNow = false;
  showHints();

  const fb = $('#p-feedback');
  const finish = () => {
    $('#p-submit').hidden = true;
    $('#p-skip').hidden = true;
    solvedNow = true;
    showHints();
    $('#p-text').disabled = true;
    $('#p-options').querySelectorAll('button').forEach((x) => (x.disabled = true));
    $('#p-next').hidden = false;
    $('#p-next').focus();
  };

  $('#answer-form').onsubmit = async (e) => {
    e.preventDefault();
    const answer = p.type === 'choice' ? chosen : $('#p-text').value;
    if (!answer || !answer.trim()) return;
    const correct = p.answerHashes.includes(await hashAnswer(p.id, answer));
    fb.hidden = false;
    fb.className = 'feedback ' + (correct ? 'ok' : 'bad');
    fb.textContent = correct ? '✅ إجابة صحيحة!' : '❌ ليست صحيحة. حاول مرة أخرى!';
    if (correct) {
      progress.solved.push(p.id);
      saveProgress(progress);
      showJewels();
      fb.textContent = `✅ إجابة صحيحة! +${JEWELS_PER_SOLVE} 💎`;
      if (p.answerImage) {
        $('#p-answer-image').src = p.answerImage;
        $('#p-answer-image').hidden = false;
      }
      finish();
    }
  };

  $('#p-skip').onclick = () => {
    if (!confirm('تتخطى هذا اللغز؟ سيُحسب غير محلول.')) return;
    progress.skipped.push(p.id);
    saveProgress(progress);
    play();
  };

  $('#p-next').onclick = play;
}

function submit() {
  mount('t-submit');
  const form = app.querySelector('#submit-form');
  const err = form.querySelector('.error');
  form.querySelectorAll('[name=type]').forEach((r) => {
    r.onchange = () => (app.querySelector('#s-options').hidden = form.type.value !== 'choice');
  });

  // Up to 5 alternative answers, each in its own box.
  const alts = app.querySelector('#s-alts');
  const addAlt = app.querySelector('#s-add-alt');
  const updateAddAlt = () => (addAlt.hidden = alts.children.length >= MAX_ALTS);
  addAlt.onclick = () => {
    const input = el('input', { name: 'alt', placeholder: `إجابة بديلة ${alts.children.length + 1}`, maxLength: 200 });
    const remove = el('button', { type: 'button', className: 'link', textContent: '✕', title: 'احذف' });
    const row = el('div', { className: 'alt-row' }, input, remove);
    remove.onclick = () => {
      row.remove();
      alts.querySelectorAll('input').forEach((x, i) => (x.placeholder = `إجابة بديلة ${i + 1}`));
      updateAddAlt();
    };
    alts.append(row);
    updateAddAlt();
    input.focus();
  };

  // Up to 4 hints, each small or big.
  const hintsBox = app.querySelector('#s-hints');
  const addHint = app.querySelector('#s-add-hint');
  const updateAddHint = () => (addHint.hidden = hintsBox.children.length >= MAX_HINTS);
  addHint.onclick = () => {
    const input = el('input', { placeholder: `التلميح ${hintsBox.children.length + 1}`, maxLength: 300 });
    const size = el('select', { title: 'حجم التلميح' },
      el('option', { value: 'small', textContent: 'صغير (٢ 💎)' }),
      el('option', { value: 'big', textContent: 'كبير (٤ 💎)' }));
    const remove = el('button', { type: 'button', className: 'link', textContent: '✕', title: 'احذف' });
    const row = el('div', { className: 'hint-row' }, input, size, remove);
    remove.onclick = () => {
      row.remove();
      hintsBox.querySelectorAll('input').forEach((x, i) => (x.placeholder = `التلميح ${i + 1}`));
      updateAddHint();
    };
    hintsBox.append(row);
    updateAddHint();
    input.focus();
  };

  for (const [input, preview] of [[form.qImage, '#s-q-preview'], [form.aImage, '#s-a-preview']]) {
    input.onchange = () => {
      const f = input.files[0];
      const img = app.querySelector(preview);
      img.hidden = !f;
      if (f) img.src = URL.createObjectURL(f);
    };
  }
  const submitBtn = form.querySelector('[type=submit]');

  form.onsubmit = async (e) => {
    e.preventDefault();
    showMsg(err);
    const type = form.type.value;
    const answers = [form.answers.value, ...[...alts.querySelectorAll('input')].map((x) => x.value)]
      .flatMap((s) => s.split('|'))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((a, i, all) => all.findIndex((b) => normalize(b) === normalize(a)) === i);
    const options = type === 'choice' ? form.options.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6) : [];
    if (!answers.length) return showMsg(err, 'اكتب الإجابة الصحيحة.');
    if (type === 'choice') {
      if (options.length < 2) return showMsg(err, 'الاختيار من متعدد يحتاج خيارين على الأقل.');
      if (!answers.every((a) => options.some((o) => normalize(o) === normalize(a)))) return showMsg(err, 'الإجابة الصحيحة يجب أن تكون أحد الخيارات.');
    }
    const hints = [...hintsBox.querySelectorAll('.hint-row')]
      .map((row) => ({ text: row.querySelector('input').value.trim().slice(0, 300), size: row.querySelector('select').value }))
      .filter((h) => h.text);
    const cfg = savesConfig(settings);
    if (!cfg) return showMsg(err, 'إرسال الألغاز غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
    const qFile = form.qImage.files[0];
    const aFile = form.aImage.files[0];
    submitBtn.disabled = true;
    try {
      const id = 'p-' + Date.now().toString(36) + randomHex(2);
      const images = {};
      for (const [key, file, label] of [['q', qFile, 'صورة السؤال'], ['a', aFile, 'صورة الإجابة']]) {
        if (!file) continue;
        submitBtn.textContent = '⏳ جارٍ رفع الصور…';
        const pic = await shrinkPicture(file).catch(() => null);
        if (!pic) throw new Error(`${label} ليست صورة صالحة.`);
        if (pic.bytes.length > 2 * 1024 * 1024) throw new Error(`${label} كبيرة جدًا. اختر صورة أصغر.`);
        const path = `pending/${id}-${key}.${pic.ext}`;
        await savesPutFile(cfg, path, pic.bytes, `Puzzle picture from ${me.username}`);
        images[key] = path;
      }
      submitBtn.textContent = '⏳ جارٍ الإرسال…';
      await updateSaves(cfg, (all) => {
        all[id] = {
          id,
          question: form.question.value.trim().slice(0, 1000),
          type,
          options,
          // Lightly scrambled so the answers aren't sitting there in plain text.
          answersHidden: hideKey(JSON.stringify(answers)),
          hints,
          images,
          author: me.displayName,
          by: me.username,
          submittedAt: new Date().toISOString(),
        };
      }, `Puzzle from ${me.username}`, PENDING_FILE);
    } catch (e2) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'أرسل اللغز';
      return showMsg(err, /^(upload|saves)/.test(e2.message) ? 'تعذّر الإرسال. تحقق من الإنترنت وحاول مرة أخرى.' : e2.message);
    }
    mount('t-code');
    app.querySelector('#c-title').textContent = '✅ وصل لغزك!';
    app.querySelector('#c-text').textContent = 'أُرسل لغزك إلى المشرف، وسيظهر في اللعبة بعد موافقته. تحصل على جوهرة هدية عند قبوله.';
    app.querySelector('#c-code').hidden = true;
    app.querySelector('#c-after').textContent = '';
    app.querySelector('#c-back').textContent = 'أضف لغزًا آخر';
    app.querySelector('#c-back').onclick = submit;
  };
}

// Phone photos are often huge: shrink big pictures to at most 1600px.
async function shrinkPicture(file) {
  const exts = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const small = file.size <= 1024 * 1024 && exts[file.type];
  if (small || file.type === 'image/gif') return { bytes: new Uint8Array(await file.arrayBuffer()), ext: exts[file.type] || 'gif' };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'jpg' };
}

function profile() {
  mount('t-profile');
  const $ = (s) => app.querySelector(s);
  const progress = loadProgress();
  const mine = puzzlesBy(me.username, puzzles, users);
  $('#pr-name').textContent = me.displayName;
  $('#pr-username').textContent = '@' + me.username;
  $('#pr-joined').textContent = me.joinedAt || '—';
  $('#pr-jewels').textContent = `💎 ${jewels(progress)}`;
  $('#pr-solved').textContent = puzzles.filter((p) => progress.solved.includes(p.id)).length;
  $('#pr-live').textContent = mine.length;
  $('#pr-pending').textContent = '…';
  const cfg0 = savesConfig(settings);
  if (cfg0) {
    readSaves(cfg0, PENDING_FILE)
      .then(({ data }) => ($('#pr-pending').textContent = Object.values(data).filter((x) => x.by === me.username).length))
      .catch(() => ($('#pr-pending').textContent = '—'));
  } else $('#pr-pending').textContent = '—';

  // Hide my name on the leaderboard.
  const anon = $('#pr-anon');
  const anonMsg = $('#pr-anon-msg');
  anon.checked = !!(saves[me.username] || {}).anonymous;
  anon.onchange = async () => {
    const cfg = savesConfig(settings);
    if (!cfg) {
      anon.checked = !anon.checked;
      return (anonMsg.textContent = 'غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
    }
    anon.disabled = true;
    anonMsg.textContent = '⏳ جارٍ الحفظ…';
    const value = anon.checked;
    try {
      saves = await updateSaves(cfg, (all) => {
        all[me.username] = { ...all[me.username], anonymous: value };
      }, `Leaderboard: ${me.username}`);
      anonMsg.textContent = value ? 'تم ✓ تظهر في لوحة المتصدرين باسم "مجهول".' : 'تم ✓ يظهر اسمك في لوحة المتصدرين.';
    } catch {
      anon.checked = !value;
      anonMsg.textContent = 'تعذّر الحفظ. تحقق من الإنترنت وحاول مرة أخرى.';
    } finally {
      anon.disabled = false;
    }
  };
  $('#pr-jewels-why').textContent = 'تحصل على جوهرتين لكل لغز تحله، وجوهرة هدية لكل لغز من ألغازك يُقبل في اللعبة. التلميح الصغير يكلّف جوهرتين، والكبير ٤ جواهر.';

  const list = $('#pr-puzzles');
  if (!mine.length) list.append(el('li', { className: 'empty muted', textContent: 'لم يُقبل لك لغز بعد. أضف لغزًا من صفحة "أضف لغزًا".' }));
  mine.forEach((p) => list.append(el('li', {},
    el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
    el('div', { className: 'meta', textContent: `🎁 +${PUZZLE_GIFT} 💎 · ${p.addedAt || ''}` }))));

  const form = $('#name-form');
  const err = form.querySelector('.error');
  const ok = form.querySelector('.success');
  form.displayName.value = me.displayName;
  form.onsubmit = async (e) => {
    e.preventDefault();
    showMsg(err);
    showMsg(ok);
    const name = form.displayName.value.trim().slice(0, 40);
    if (!name) return showMsg(err, 'اكتب اسمًا.');
    const cfg = savesConfig(settings);
    if (!cfg) return showMsg(err, 'تغيير الاسم غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      saves = await updateSaves(cfg, (all) => {
        all[me.username] = { ...all[me.username], displayName: name };
      }, `Name: ${me.username}`);
      me = { ...me, displayName: name };
      document.getElementById('whoami').textContent = name;
      $('#pr-name').textContent = name;
      showMsg(ok, 'تم حفظ اسمك ✓');
    } catch {
      showMsg(err, 'تعذّر حفظ الاسم. تحقق من الإنترنت وحاول مرة أخرى.');
    } finally {
      btn.disabled = false;
    }
  };
}

// Fetch the latest players, puzzles and saves (new puzzles may have been added).
async function refreshData() {
  try {
    const [u, p, s] = await loadData();
    users = u;
    puzzles = p;
    settings = s || {};
  } catch {}
  const cfg = savesConfig(settings);
  if (cfg) {
    try {
      saves = (await readSaves(cfg)).data;
    } catch {}
  }
}

async function leaderboardView() {
  mount('t-leaderboard');
  const board = app.querySelector('#board');
  await refreshData();
  if (location.hash !== '#leaderboard') return; // they moved on while it loaded
  // My own progress on this device is the freshest.
  const mineNow = { ...saves, [me.username]: { ...saves[me.username], ...loadProgress() } };
  const rows = leaderboard(users, puzzles, mineNow);
  board.replaceChildren();
  if (!rows.length) board.append(el('li', { className: 'muted', textContent: 'لا يوجد لاعبون بعد.' }));
  let rank = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.solved !== r.solved || prev.jewels !== r.jewels) rank = i + 1;
    const medal = ['🥇', '🥈', '🥉'][rank - 1] || String(rank);
    let name = r.anonymous ? 'مجهول' : r.name;
    if (r.anonymous && me.admin) name += ` (${r.name})`;
    if (r.username === me.username) name += ' (أنت)';
    board.append(el('li', { className: r.username === me.username ? 'me' : '' },
      el('span', { className: 'rank', textContent: medal }),
      el('span', { className: 'who', textContent: name }),
      el('span', { className: 'stats', textContent: `✅ ${r.solved} · 💎 ${r.jewels}` })));
  });
}

// ---------- start ----------

// The admin's device reads straight from GitHub so changes show at once;
// everyone else reads the published site files.
async function loadData() {
  if (getKey()) {
    try {
      const [u, p, s] = await Promise.all([readRepoJson('users'), readRepoJson('puzzles'), readRepoJson('settings')]);
      return [u.data, p.data, s.data];
    } catch {}
  }
  return Promise.all([
    loadJson('data/users.json'),
    loadJson('data/puzzles.json'),
    loadJson('data/settings.json').catch(() => ({})),
  ]);
}

loadData()
  .then(async ([u, p, s]) => {
    users = u;
    puzzles = p;
    settings = s || {};
    let saved = null;
    try { saved = localStorage.getItem('sawg-user'); } catch {}
    me = users.find((x) => x.username === saved && x.status === 'active') || null;
    if (me) await syncDown();
    route();
  })
  .catch((e) => app.replaceChildren(el('p', { className: 'error', textContent: e.message })));
