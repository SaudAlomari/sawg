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
    if (p && Array.isArray(p.solved) && Array.isArray(p.skipped)) return p;
  } catch {}
  return { solved: [], skipped: [] };
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

const views = { play, submit };

function route() {
  const nav = document.getElementById('nav');
  if (!me) {
    nav.hidden = true;
    return authView();
  }
  nav.hidden = false;
  document.getElementById('whoami').textContent = me.displayName;
  let page = location.hash.slice(1) || 'play';
  if (!views[page]) page = 'play';
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
  let mode = 'signin';
  app.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      mode = btn.dataset.tab;
      app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      app.querySelectorAll('.signup-only').forEach((x) => (x.hidden = mode !== 'signup'));
      submitBtn.textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
      form.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      showMsg(err);
    };
  });

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
          return showMsg(err, "Wrong username or password. If you just signed up, the admin may not have activated you yet.");
        }
        if (user.status !== 'active') return showMsg(err, 'Your account is not active. Please ask the admin.');
        me = user;
        remember(user.username);
        route();
      } else {
        if (!/^[a-z0-9_.-]{3,20}$/.test(username)) return showMsg(err, 'Username must be 3–20 letters, numbers, dots, dashes or underscores.');
        if (password.length < 6) return showMsg(err, 'Password must be at least 6 characters.');
        if (users.some((u) => u.username === username)) return showMsg(err, 'That username is taken.');
        const salt = randomHex(16);
        const code = makeCode('USER', {
          username,
          displayName: form.displayName.value.trim().slice(0, 40) || username,
          salt,
          hash: await hashPassword(password, salt),
          requestedAt: new Date().toISOString(),
        });
        codeView({
          title: 'Almost there!',
          text: 'Send this sign-up code to the admin. Once they activate you, come back and sign in with your username and password.',
          code,
          after: "Your password is scrambled inside the code, so it's safe to send.",
          back: 'Back to sign in',
          onBack: authView,
        });
      }
    } finally {
      submitBtn.disabled = false;
    }
  };
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

  if (!p) {
    $('#p-count').textContent = `${puzzles.length} of ${puzzles.length}`;
    $('#puzzle').hidden = true;
    $('#done').hidden = false;
    const solved = puzzles.filter((x) => progress.solved.includes(x.id)).length;
    $('#done-score').textContent = `You solved ${solved} of ${puzzles.length}.`;
    $('#restart').onclick = () => {
      if (!confirm('Start over from puzzle 1? Your progress on this device will be cleared.')) return;
      saveProgress({ solved: [], skipped: [] });
      play();
    };
    return;
  }

  $('#p-count').textContent = `Puzzle ${doneCount + 1} of ${puzzles.length}`;
  $('#p-author').textContent = 'By ' + p.author;
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

  if (p.hint) {
    $('#p-hint').hidden = false;
    $('#p-hint').onclick = () => {
      $('#p-hint-text').textContent = '💡 ' + p.hint;
      $('#p-hint-text').hidden = false;
      $('#p-hint').hidden = true;
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
    fb.textContent = correct ? '✅ Correct!' : '❌ Not quite. Try again!';
    if (correct) {
      progress.solved.push(p.id);
      saveProgress(progress);
      finish();
    }
  };

  $('#p-skip').onclick = () => {
    if (!confirm('Skip this puzzle? It will count as not solved.')) return;
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
    if (!answers.length) return showMsg(err, 'Give the correct answer.');
    if (type === 'choice') {
      if (options.length < 2) return showMsg(err, 'Multiple choice needs at least 2 options.');
      if (!answers.every((a) => options.some((o) => normalize(o) === normalize(a)))) return showMsg(err, 'The correct answer must be one of the options.');
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
      title: 'Your puzzle code',
      text: 'Send this code to the admin' + (form.hasImage.checked ? ', together with your picture.' : '.') + " It'll appear in the game once it's approved.",
      code,
      after: "Don't share it with other players: it contains the answer!",
      back: 'Submit another puzzle',
      onBack: submit,
    });
  };
}

// ---------- start ----------

Promise.all([loadJson('data/users.json'), loadJson('data/puzzles.json')])
  .then(([u, p]) => {
    users = u;
    puzzles = p;
    let saved = null;
    try { saved = localStorage.getItem('sawg-user'); } catch {}
    me = users.find((x) => x.username === saved && x.status === 'active') || null;
    route();
  })
  .catch((e) => app.replaceChildren(el('p', { className: 'error', textContent: e.message })));
