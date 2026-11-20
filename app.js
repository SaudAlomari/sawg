'use strict';
// The player site. Reads data/users.json and data/puzzles.json from the repo.
// Sign-ups and puzzles become codes that players send to the admin.

const app = document.getElementById('app');
let users = [];
let puzzles = [];
let me = null;

function mount(id) {
  app.replaceChildren(document.getElementById(id).content.cloneNode(true));
}

// ---------- progress (kept on this device) ----------

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

// Jewels: +2 for each solved puzzle, −5 for each hint opened.
const JEWELS_PER_SOLVE = 2;
const HINT_COST = 5;
function jewels(progress) {
  return progress.solved.length * JEWELS_PER_SOLVE - progress.hinted.length * HINT_COST;
}
function saveProgress(p) {
  try { localStorage.setItem(progressKey(), JSON.stringify(p)); } catch {}
}
function remember(username) {
  try {
    if (username) localStorage.setItem('sawg-user', username);
    else localStorage.removeItem('sawg-user');
  } catch {}
}

// ---------- routing ----------

const views = { play, submit, admin: () => adminView(app) };

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

  if (!p) {
    $('#p-count').textContent = `${puzzles.length} من ${puzzles.length}`;
    $('#puzzle').hidden = true;
    $('#done').hidden = false;
    const solved = puzzles.filter((x) => progress.solved.includes(x.id)).length;
    $('#done-score').textContent = `حللت ${solved} من ${puzzles.length}.`;
    $('#done-jewels').textContent = `💎 ${jewels(progress)} جوهرة`;
    $('#restart').onclick = () => {
      if (!confirm('تبدأ من جديد من اللغز الأول؟ سيُمسح تقدمك وجواهرك على هذا الجهاز.')) return;
      saveProgress({ solved: [], skipped: [], hinted: [] });
      play();
    };
    return;
  }

  $('#p-count').textContent = `اللغز ${doneCount + 1} من ${puzzles.length}`;
  $('#p-author').textContent = 'من: ' + p.author;
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

  // Hint: costs jewels, and is free to look at again once bought.
  const hintBtn = $('#p-hint');
  const revealHint = () => {
    $('#p-hint-text').textContent = '💡 ' + p.hint;
    $('#p-hint-text').hidden = false;
    hintBtn.hidden = true;
  };
  if (!p.hint) {
    hintBtn.disabled = true;
    hintBtn.textContent = 'لا يوجد تلميح';
  } else if (progress.hinted.includes(p.id)) {
    revealHint();
  } else if (jewels(progress) < HINT_COST) {
    hintBtn.disabled = true;
    hintBtn.title = `تحتاج ${HINT_COST} جواهر للتلميح`;
    hintBtn.textContent = `💡 التلميح يحتاج ${HINT_COST} 💎`;
  } else {
    hintBtn.onclick = () => {
      if (!confirm(`تستخدم ${HINT_COST} جواهر لرؤية التلميح؟`)) return;
      progress.hinted.push(p.id);
      saveProgress(progress);
      showJewels();
      revealHint();
    };
  }

  const fb = $('#p-feedback');
  const finish = () => {
    $('#p-submit').hidden = true;
    $('#p-skip').hidden = true;
    $('#p-hint').hidden = true;
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

  form.onsubmit = (e) => {
    e.preventDefault();
    showMsg(err);
    const type = form.type.value;
    const answers = form.answers.value.split('|').map((s) => s.trim()).filter(Boolean);
    const options = type === 'choice' ? form.options.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6) : [];
    if (!answers.length) return showMsg(err, 'اكتب الإجابة الصحيحة.');
    if (type === 'choice') {
      if (options.length < 2) return showMsg(err, 'الاختيار من متعدد يحتاج خيارين على الأقل.');
      if (!answers.every((a) => options.some((o) => normalize(o) === normalize(a)))) return showMsg(err, 'الإجابة الصحيحة يجب أن تكون أحد الخيارات.');
    }
    const code = makeCode('PUZZLE', {
      question: form.question.value.trim().slice(0, 1000),
      type,
      options,
      answers,
      hint: form.hint.value.trim().slice(0, 300),
      hasImage: form.hasImage.checked,
      author: me.displayName,
      by: me.username,
    });
    codeView({
      title: 'رمز لغزك',
      text: 'أرسل هذا الرمز إلى المشرف' + (form.hasImage.checked ? ' مع الصورة.' : '.') + ' سيظهر لغزك في اللعبة بعد الموافقة عليه.',
      code,
      after: 'لا تشاركه مع اللاعبين الآخرين، ففيه الإجابة!',
      back: 'أضف لغزًا آخر',
      onBack: submit,
    });
  };
}

// ---------- start ----------

// The admin's device reads straight from GitHub so changes show at once;
// everyone else reads the published site files.
async function loadData() {
  if (getKey()) {
    try {
      const [u, p] = await Promise.all([readRepoJson('users'), readRepoJson('puzzles')]);
      return [u.data, p.data];
    } catch {}
  }
  return Promise.all([loadJson('data/users.json'), loadJson('data/puzzles.json')]);
}

loadData()
  .then(([u, p]) => {
    users = u;
    puzzles = p;
    let saved = null;
    try { saved = localStorage.getItem('sawg-user'); } catch {}
    me = users.find((x) => x.username === saved && x.status === 'active') || null;
    route();
  })
  .catch((e) => app.replaceChildren(el('p', { className: 'error', textContent: e.message })));
