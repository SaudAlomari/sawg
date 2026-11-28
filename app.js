'use strict';
// The player site. Reads data/users.json and data/puzzles.json from the repo.
// Sign-ups and puzzles become codes that players send to the admin.

const app = document.getElementById('app');
let users = [];
let puzzles = [];
let me = null;
let settings = {};
let saves = {}; // usersSavedData.json: progress and profile names
let groups = withDefaultGroup([]); // data/groups.json (see saves.js)
let adminPick = null; // the admin tapped a dot: play this puzzle next

// My group, from the latest users.json (the admin may have moved me).
function myGroup() {
  return groupOf(users.find((u) => u.username === me.username) || me, groups);
}

// The puzzles I can play: the ones shown to my group. The admin sees them all.
function myPuzzles() {
  if (me.admin) return puzzles;
  const g = myGroup();
  return puzzles.filter((p) => puzzleShownTo(p, g));
}

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
      if (!p.postponed || typeof p.postponed !== 'object') p.postponed = {};
      p.postpones = p.postpones || 0;
      if (!p.misses || typeof p.misses !== 'object') p.misses = {};
      if (!p.extra || typeof p.extra !== 'object') p.extra = {};
      if (!p.word || typeof p.word !== 'object') p.word = {};
      if (!p.wordle || typeof p.wordle !== 'object') p.wordle = {};
      return p;
    }
  } catch {}
  return { solved: [], skipped: [], hinted: [], postponed: {}, postpones: 0, misses: {}, extra: {}, word: {}, wordle: {} };
}

// Jewels: +2 for each solved puzzle (multiple choice: 2 on the first try,
// 1 on the second, 0 after), minus what hints cost (2 small, 4 big),
// −1 for each postponed puzzle, +1 for each of your puzzles that is in the game.
const JEWELS_PER_SOLVE = 2;
const POSTPONE_AFTER = 3;
const MAX_ALTS = 5; // alternative answers on top of the main one
function jewels(progress) {
  // Jewels the admin took away are kept in the account (saves), not on the device.
  const deducted = (saves[me.username] || {}).deducted || 0;
  return savedJewels({ ...progress, deducted }, puzzlesBy(me.username, puzzles, users).length);
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
  pending = { username: me.username, progress: { solved: p.solved, skipped: p.skipped, hinted: p.hinted, postponed: p.postponed || {}, postpones: p.postpones || 0, misses: p.misses || {}, extra: p.extra || {}, word: p.word || {}, wordle: p.wordle || {}, current: p.current || null } };
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
    if (saved) saveLocal({ solved: saved.solved || [], skipped: saved.skipped || [], hinted: saved.hinted || [], postponed: saved.postponed || {}, postpones: saved.postpones || 0, misses: saved.misses || {}, extra: saved.extra || {}, word: saved.word || {}, wordle: saved.wordle || {}, current: saved.current || null });
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

const views = { play, words: wordsPage, submit, leaderboard: leaderboardView, profile, admin: () => adminView(app) };

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
    form.password2.required = m === 'signup';
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
          if (!user && (await signupWaiting(username))) return showMsg(err, '⏳ حسابك بانتظار موافقة المشرف. حاول مرة أخرى لاحقًا.');
          return showMsg(err, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
        }
        if (user.status !== 'active') return showMsg(err, 'حسابك غير مفعّل. تواصل مع المشرف.');
        me = user;
        remember(user.username);
        await syncDown();
        route();
      } else {
        if (!/^[a-z0-9_.-]{3,20}$/.test(username)) return showMsg(err, 'اسم المستخدم من ٣ إلى ٢٠ حرفًا إنجليزيًا أو أرقامًا (يُسمح بـ . و - و _).');
        if (password.length < 6) return showMsg(err, 'كلمة المرور يجب أن تكون ٦ أحرف على الأقل.');
        if (password !== form.password2.value) return showMsg(err, 'كلمتا المرور غير متطابقتين.');
        if (users.some((u) => u.username === username)) return showMsg(err, 'اسم المستخدم هذا مستخدم من قبل.');
        const salt = randomHex(16);
        if (firstRun) return await createAdmin(username, password, salt, err);
        // Everyone else waits in pendingSignups.json until the admin activates them.
        const cfg = savesConfig(settings);
        if (!cfg) return showMsg(err, 'التسجيل غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
        const entry = {
          username,
          displayName: username, // they can change it in their profile
          salt,
          hash: await hashPassword(password, salt), // never the password itself
          requestedAt: new Date().toISOString(),
        };
        try {
          await updateSaves(cfg, (all) => {
            if (all[username]) throw new Error('taken');
            all[username] = entry;
          }, `Sign-up: ${username}`, SIGNUPS_FILE);
        } catch (e2) {
          return showMsg(err, e2.message === 'taken' ? 'اسم المستخدم هذا مستخدم من قبل.' : 'تعذّر التسجيل. تحقق من الإنترنت وحاول مرة أخرى.');
        }
        mount('t-code');
        app.querySelector('#c-title').textContent = '✅ وصل طلبك!';
        app.querySelector('#c-text').textContent = 'حسابك بانتظار موافقة المشرف. بعد أن يفعّله، سجّل الدخول باسم المستخدم وكلمة المرور.';
        app.querySelector('#c-back').textContent = 'العودة لتسجيل الدخول';
        app.querySelector('#c-back').onclick = () => authView();
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
      displayName: username, // they can change it in their profile
      salt,
      hash: await hashPassword(password, salt),
      status: 'active',
      admin: true,
      joinedAt: new Date().toISOString().slice(0, 10),
      group: DEFAULT_GROUP,
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

// Is this username waiting for the admin?
async function signupWaiting(username) {
  const cfg = savesConfig(settings);
  if (!cfg) return false;
  try {
    return !!(await readSaves(cfg, SIGNUPS_FILE)).data[username];
  } catch {
    return false;
  }
}

function play() {
  mount('t-play');
  const $ = (s) => app.querySelector(s);
  const progress = loadProgress();
  const puzzles = myPuzzles(); // only my group's puzzles
  const done = new Set([...progress.solved, ...progress.skipped]);
  const doneCount = puzzles.filter((p) => done.has(p.id)).length;
  // A postponed puzzle waits until 3 more puzzles are done (or nothing else is left).
  const left = puzzles.filter((x) => !done.has(x.id));
  const waiting = (x) => (progress.postponed[x.id] || 0) > doneCount;
  // Stay on the puzzle you were on, even if the admin changed the order;
  // after it, the next is the first unsolved puzzle in the current order.
  const current = left.find((x) => x.id === progress.current && !waiting(x));
  // Admin only: a tapped dot opens that puzzle. One already solved or skipped
  // is played for practice and changes nothing (no jewels, no progress).
  const pick = me.admin && adminPick ? puzzles.find((x) => x.id === adminPick) : null;
  adminPick = null;
  const practice = !!pick && done.has(pick.id);
  const p = pick || current || left.find((x) => !waiting(x)) || [...left].sort((x, y) => progress.postponed[x.id] - progress.postponed[y.id])[0];
  if (p && !practice && progress.current !== p.id) {
    progress.current = p.id;
    saveProgress(progress); // saved to the account too, so other devices stay on it
  }

  // One dot per puzzle: green solved, amber skipped, grey not yet.
  // The admin can tap any dot to play that puzzle.
  $('#p-dots').replaceChildren(...puzzles.map((x, i) => {
    const dot = el(me.admin ? 'button' : 'span', {
      className: 'dot' + (progress.solved.includes(x.id) ? ' solved' : progress.skipped.includes(x.id) ? ' skipped' : '') + (p && x.id === p.id ? ' now' : ''),
      title: `${i + 1}`,
    });
    if (me.admin) {
      dot.type = 'button';
      dot.setAttribute('aria-label', `اللغز ${i + 1}`);
      dot.onclick = () => {
        adminPick = x.id;
        play();
      };
    }
    return dot;
  }));
  // The dots are one sliding row: bring the current puzzle's dot to the middle.
  const dots = $('#p-dots');
  const nowDot = dots.querySelector('.now');
  if (nowDot) {
    const box = dots.getBoundingClientRect();
    const d = nowDot.getBoundingClientRect();
    dots.scrollLeft += d.left + d.width / 2 - (box.left + box.width / 2);
  }
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
      if (myPuzzles().length !== before && (location.hash.slice(1) || 'play') === 'play' && app.querySelector('#done')) play();
    });
    return;
  }

  // The admin jumps around, so show where this puzzle sits in the list.
  $('#p-count').textContent = `اللغز ${me.admin ? puzzles.indexOf(p) + 1 : doneCount + 1} من ${puzzles.length}` + (practice ? ' · تجربة بدون جواهر' : '');
  $('#p-author').textContent = 'من: ' + puzzleAuthor(p, users, saves, me, groups);
  $('#p-question').textContent = p.question;
  if (p.image && p.type !== 'photo') {
    $('#p-image').src = p.image;
    $('#p-image').hidden = false;
  }

  let chosen = null;
  let photoDone = null; // set below for photo puzzles
  if (p.type === 'photo') {
    // Tap a piece, then another, to swap them. Everyone starts from the same scramble.
    const grid = p.grid === 3 ? 3 : 2;
    const order = (validScramble(p.scramble, grid) ? p.scramble : makeScramble(grid)).slice();
    const board = el('div', { className: 'photo-board', dir: 'ltr' }); // pieces always read left to right, like the photo
    board.style.gridTemplateColumns = `repeat(${grid}, 1fr)`;
    const pic = new Image();
    pic.onload = () => (board.style.aspectRatio = `${pic.naturalWidth} / ${pic.naturalHeight}`);
    pic.src = p.image;
    let picked = null;
    const draw = () => {
      board.replaceChildren(...order.map((t, i) => {
        const tile = el('button', { type: 'button', className: 'tile' + (picked === i ? ' picked' : ''), title: `${i + 1}` });
        tile.style.backgroundImage = `url("${p.image}")`;
        tile.style.backgroundSize = `${grid * 100}% ${grid * 100}%`;
        tile.style.backgroundPosition = `${((t % grid) * 100) / (grid - 1)}% ${(Math.floor(t / grid) * 100) / (grid - 1)}%`;
        tile.onclick = () => {
          if (solvedNow) return;
          if (picked === null) picked = i;
          else {
            [order[picked], order[i]] = [order[i], order[picked]];
            picked = null;
            if (order.every((x, k) => x === k)) {
              board.classList.add('whole'); // close the gaps to show the full photo
              photoDone(order.join(','));
            }
          }
          draw();
        };
        return tile;
      }));
    };
    draw();
    $('#p-options').before(el('p', { className: 'muted small', textContent: `اضغط على قطعتين لتبديل مكانهما حتى تكتمل الصورة. المكافأة: ${grid === 3 ? 3 : 2} 💎` }), board);
    $('#p-submit').hidden = true;
  } else if (p.type === 'word') {
    $('#p-submit').hidden = true;
    wordGame(p, practice, progress, $('#p-options'), $('#p-feedback'), () => win());
  } else if (p.type === 'choice') {
    const note = el('p', { className: 'muted small', textContent: 'من أول محاولة: ٢ 💎 · من الثانية: ١ 💎 · بعدها: ٠' });
    $('#p-options').before(note);
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
  }

  // Hints: each costs jewels (small 2, big 4) and stays open once bought.
  const hintsBox = $('#p-hints');
  const showHints = () => {
    hintsBox.replaceChildren();
    puzzleHints(p).forEach((h, i) => {
      const size = h.size === 'small' ? 'small' : 'big';
      const label = size === 'small' ? 'تلميح صغير' : 'تلميح كبير';
      const cost = HINT_COSTS[size];
      if (practice || hintOpened(progress.hinted, p, i)) {
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
    $('#p-postpone').hidden = true;
    solvedNow = true;
    showHints();
    $('#p-text').disabled = true;
    $('#p-options').querySelectorAll('button').forEach((x) => (x.disabled = true));
    $('#p-next').hidden = false;
    $('#p-next').focus();
  };

  const check = async (answer) => {
    if (!answer || !answer.trim()) return;
    const tries = p.type === 'text' ? answerVariants(answer) : [answer];
    const hashes = await Promise.all(tries.map((x) => hashAnswer(p.id, x)));
    const correct = hashes.some((h) => p.answerHashes.includes(h));
    fb.hidden = false;
    fb.className = 'feedback ' + (correct ? 'ok' : 'bad');
    fb.textContent = correct ? '✅ إجابة صحيحة!' : '❌ ليست صحيحة. حاول مرة أخرى!';
    if (!correct && p.type === 'choice' && practice) {
      $('#p-options').querySelectorAll('button.selected').forEach((x) => {
        x.disabled = true;
        x.classList.remove('selected');
        x.classList.add('wrong');
      });
      chosen = null;
    } else if (!correct && p.type === 'choice') {
      // Each wrong choice lowers the reward; that choice can't be picked again.
      progress.misses[p.id] = (progress.misses[p.id] || 0) + 1;
      saveProgress(progress);
      $('#p-options').querySelectorAll('button.selected').forEach((x) => {
        x.disabled = true;
        x.classList.remove('selected');
        x.classList.add('wrong');
      });
      chosen = null;
      const left = solveReward(progress, p.id);
      fb.textContent += left ? ` إذا أصبت الآن تحصل على ${left} 💎.` : ' لن تحصل على جواهر لهذا اللغز، لكن تستطيع حله.';
    }
    if (correct) win();
  };
  const win = () => {
    fb.hidden = false;
    fb.className = 'feedback ok';
    if (practice) {
      fb.textContent = '✅ إجابة صحيحة! (تجربة، بدون جواهر)';
      if (p.answerImage) {
        $('#p-answer-image').src = p.answerImage;
        $('#p-answer-image').hidden = false;
      }
      finish();
    } else {
      if (p.type === 'photo' && p.grid === 3) progress.extra[p.id] = 1; // 9 pieces: 3 jewels
      if (p.type === 'word') {
        progress.extra[p.id] = wordLength(p) - 3; // letters − 1 jewels
        delete progress.word[p.id];
      }
      progress.solved.push(p.id);
      saveProgress(progress);
      showJewels();
      fb.textContent = `✅ إجابة صحيحة! +${solveReward(progress, p.id)} 💎`;
      if (p.answerImage) {
        $('#p-answer-image').src = p.answerImage;
        $('#p-answer-image').hidden = false;
      }
      finish();
    }
  };
  photoDone = check;
  $('#answer-form').onsubmit = (e) => {
    e.preventDefault();
    if (p.type !== 'photo' && p.type !== 'word') check(p.type === 'choice' ? chosen : $('#p-text').value);
  };

  // Postpone: costs 1 jewel, the puzzle comes back after 3 more puzzles.
  const postpone = $('#p-postpone');
  const others = left.filter((x) => x.id !== p.id && !waiting(x)).length;
  if (!others) {
    postpone.disabled = true;
    postpone.title = 'لا توجد ألغاز أخرى الآن';
  } else if (jewels(progress) < POSTPONE_COST) {
    postpone.disabled = true;
    postpone.title = `تحتاج ${POSTPONE_COST} جوهرة`;
  }
  postpone.onclick = () => {
    if (!confirm('تؤجل هذا اللغز مقابل جوهرة واحدة؟ سيظهر لك مرة أخرى بعد ٣ ألغاز.')) return;
    progress.postponed[p.id] = doneCount + POSTPONE_AFTER;
    progress.postpones = (progress.postpones || 0) + 1;
    saveProgress(progress);
    play();
  };

  $('#p-skip').onclick = () => {
    if (!confirm('تتخطى هذا اللغز؟ سيُحسب غير محلول.')) return;
    progress.skipped.push(p.id);
    saveProgress(progress);
    play();
  };

  if (practice) {
    postpone.hidden = true;
    $('#p-skip').hidden = true;
  }

  $('#p-next').onclick = play;
}

// Add a puzzle, or change one (edit = the puzzle). Players' puzzles and
// changes wait for the admin; the admin's own are saved straight away.
function submit(edit) {
  if (edit instanceof Event || (edit && !edit.id)) edit = null;
  mount('t-submit');
  const $ = (s) => app.querySelector(s);
  const form = $('#submit-form');
  const err = form.querySelector('.error');
  const direct = me.admin && !!getKey();
  const setType = () => {
    const t = form.type.value;
    $('#s-options').hidden = t !== 'choice';
    $('#s-photo').hidden = t !== 'photo';
    $('#s-word').hidden = t !== 'word';
    $('#s-answers').hidden = t === 'photo' || t === 'word';
    // Guess the word: only the number of letters.
    form.question.parentElement.hidden = t === 'word';
    $('#s-hints-box').hidden = t === 'word';
    $('#s-pictures').hidden = t === 'word';
    form.answers.required = t !== 'photo' && t !== 'word' && !edit;
    form.question.required = t !== 'photo' && t !== 'word';
  };
  form.querySelector('.admin-only').hidden = !me.admin;
  form.querySelectorAll('[name=type]').forEach((r) => (r.onchange = setType));

  // Up to 5 alternative answers, each in its own box.
  const alts = $('#s-alts');
  const addAlt = $('#s-add-alt');
  const updateAddAlt = () => (addAlt.hidden = alts.children.length >= MAX_ALTS);
  const altRow = (value = '') => {
    const input = el('input', { name: 'alt', placeholder: `إجابة بديلة ${alts.children.length + 1}`, maxLength: 200, value });
    const remove = el('button', { type: 'button', className: 'link', textContent: '✕', title: 'احذف' });
    const row = el('div', { className: 'alt-row' }, input, remove);
    remove.onclick = () => {
      row.remove();
      alts.querySelectorAll('input').forEach((x, i) => (x.placeholder = `إجابة بديلة ${i + 1}`));
      updateAddAlt();
    };
    alts.append(row);
    updateAddAlt();
    return input;
  };
  addAlt.onclick = () => altRow().focus();

  // Up to 4 hints, each small or big.
  const hintsBox = $('#s-hints');
  const addHint = $('#s-add-hint');
  const updateAddHint = () => (addHint.hidden = hintsBox.children.length >= MAX_HINTS);
  const hintRow = (text = '', sizeValue = 'small') => {
    const input = el('input', { placeholder: `التلميح ${hintsBox.children.length + 1}`, maxLength: 300, value: text });
    const size = el('select', { title: 'حجم التلميح' },
      el('option', { value: 'small', textContent: 'صغير (٢ 💎)' }),
      el('option', { value: 'big', textContent: 'كبير (٤ 💎)' }));
    size.value = sizeValue === 'big' ? 'big' : 'small';
    const remove = el('button', { type: 'button', className: 'link', textContent: '✕', title: 'احذف' });
    const row = el('div', { className: 'hint-row' }, input, size, remove);
    remove.onclick = () => {
      row.remove();
      hintsBox.querySelectorAll('input').forEach((x, i) => (x.placeholder = `التلميح ${i + 1}`));
      updateAddHint();
    };
    hintsBox.append(row);
    updateAddHint();
    return input;
  };
  addHint.onclick = () => hintRow().focus();

  // Pictures: preview a new one; when editing, show the current one with a remove box.
  const removeBox = {};
  for (const [key, input, preview, label] of [['q', form.qImage, '#s-q-preview', 'صورة السؤال'], ['a', form.aImage, '#s-a-preview', 'صورة الإجابة']]) {
    const img = $(preview);
    const now = edit && (key === 'q' ? edit.image : edit.answerImage);
    const size = el('div', { className: 'size' });
    img.after(size);
    if (now) pictureSize(now).then((n) => !input.files[0] && (size.textContent = `حجم ${label} الحالية: ${formatSize(n)}`));
    if (now) {
      img.src = now;
      img.hidden = false;
      removeBox[key] = el('input', { type: 'checkbox' });
      removeBox[key].onchange = () => (img.hidden = removeBox[key].checked && !input.files[0]);
      img.after(el('label', { className: 'inline' }, removeBox[key], ` احذف ${label} الحالية`));
      input.parentElement.firstChild.textContent = `غيّر ${label} (اختياري) `;
    }
    input.onchange = () => {
      const f = input.files[0];
      img.hidden = !f && (!now || (removeBox[key] && removeBox[key].checked));
      img.src = f ? URL.createObjectURL(f) : now || '';
      size.textContent = f ? '⏳' : '';
      // Show the size it will have after shrinking big photos.
      if (f) shrinkPicture(f).then((pic) => input.files[0] === f && (size.textContent = `الحجم: ${formatSize(pic.bytes.length)}` + (pic.bytes.length < f.size ? ` (صُغّرت من ${formatSize(f.size)})` : '')))
        .catch(() => (size.textContent = 'ليست صورة صالحة'));
    };
  }

  let missing = []; // accepted answers nobody has typed yet; kept when saving
  if (edit) {
    $('#s-title').textContent = '✏️ عدّل اللغز';
    $('#s-intro').textContent = direct ? 'تُحفظ التعديلات في اللعبة مباشرة.' : 'تُرسل تعديلاتك إلى المشرف، ويبقى اللغز كما هو حتى يوافق عليها.';
    form.question.value = edit.question;
    form.type.value = ['choice', 'photo', 'word'].includes(edit.type) ? edit.type : 'text';
    if (edit.type === 'word') form.wordLength.value = String(wordLength(edit));
    form.grid.value = edit.grid === 3 ? '3' : '2';
    form.querySelectorAll('[name=opt]').forEach((x, i) => (x.value = (edit.options || [])[i] || ''));
    form.answers.required = false;
    form.answers.placeholder = 'اتركها فارغة لإبقاء الإجابات الحالية';
    // Show the current answers so they can be seen and changed.
    const note = el('p', { className: 'muted small' });
    alts.after(note);
    if (edit.type !== 'photo' && edit.type !== 'word') {
      note.textContent = '⏳ جارٍ تحميل الإجابات الحالية…';
      (savesConfig(settings) ? Promise.resolve() : refreshData())
        .then(() => {
          const cfg = savesConfig(settings);
          if (!cfg) throw new Error('no saves');
          return loadAnswers(cfg, edit, puzzles);
        })
        .then((found) => {
          if (!form.isConnected) return;
          const list = found && found.answers;
          if (!list) {
            note.textContent = 'الإجابات الحالية لهذا اللغز غير محفوظة. اتركها فارغة لإبقائها، أو اكتبها هنا لتظهر في المرات القادمة.';
            return;
          }
          missing = found.missing;
          note.textContent = missing.length
            ? `عُرفت ${list.length} من ${list.length + missing.length} إجابات الباقية تبقى مقبولة إذا حفظت.`
            : '';
          if (form.answers.value || alts.children.length) return; // already typing
          form.answers.value = list[0];
          list.slice(1, MAX_ALTS + 1).forEach((a) => altRow(a));
        })
        .catch(() => form.isConnected && (note.textContent = 'تعذّر تحميل الإجابات الحالية. اتركها فارغة لإبقائها كما هي.'));
    }
    puzzleHints(edit).forEach((h) => hintRow(h.text, h.size));
    form.querySelector('[type=submit]').textContent = direct ? 'احفظ التعديلات' : 'أرسل التعديلات';
  }
  setType();
  const submitBtn = form.querySelector('[type=submit]');
  const btnLabel = submitBtn.textContent;

  form.onsubmit = async (e) => {
    e.preventDefault();
    showMsg(err);
    const type = form.type.value;
    const answers = [form.answers.value, ...[...alts.querySelectorAll('input')].map((x) => x.value)]
      .flatMap((s) => s.split('|'))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((a, i, all) => all.findIndex((b) => normalize(b) === normalize(a)) === i);
    const options = type === 'choice' ? [...form.querySelectorAll('[name=opt]')].map((x) => x.value.trim()) : [];
    const editType = edit ? (['choice', 'photo', 'word'].includes(edit.type) ? edit.type : 'text') : null;
    const grid = form.grid.value === '3' ? 3 : 2;
    if (type === 'word') {
      if (!direct) return showMsg(err, 'هذا النوع يضيفه المشرف من جهاز فيه مفتاح GitHub.');
    } else if (type === 'photo') {
      const hasPhoto = form.qImage.files[0] || (edit && edit.image && !(removeBox.q && removeBox.q.checked));
      if (!hasPhoto) return showMsg(err, 'ارفع صورة السؤال لتُقطّع وتُخلط.');
    } else if (!answers.length && !edit) return showMsg(err, 'اكتب الإجابة الصحيحة.');
    if (type === 'choice') {
      if (options.some((o) => !o)) return showMsg(err, 'الاختيار من متعدد يحتاج ٤ خيارات. اكتبها كلها.');
      if (new Set(options.map(normalize)).size < 4) return showMsg(err, 'الخيارات الأربعة يجب أن تكون مختلفة.');
      if (!answers.every((a) => options.some((o) => normalize(o) === normalize(a)))) return showMsg(err, 'الإجابة الصحيحة يجب أن تكون أحد الخيارات.');
    }
    if (edit && type !== 'photo' && type !== 'word' && !answers.length && type !== editType) {
      return showMsg(err, 'غيّرت نوع الإجابة، فاكتب الإجابة الصحيحة من جديد.');
    }
    const hints = [...hintsBox.querySelectorAll('.hint-row')]
      .map((row) => ({ text: row.querySelector('input').value.trim().slice(0, 300), size: row.querySelector('select').value }))
      .filter((h) => h.text);
    const cfg = savesConfig(settings);
    if (!direct && !cfg) return showMsg(err, 'إرسال الألغاز غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
    const files = { q: form.qImage.files[0], a: form.aImage.files[0] };
    const removed = { q: !!(removeBox.q && removeBox.q.checked), a: !!(removeBox.a && removeBox.a.checked) };
    // Keep the same scramble unless the photo or the number of pieces changed.
    const keepScramble = edit && editType === 'photo' && edit.grid === grid && !files.q && validScramble(edit.scramble, grid);
    const entry = {
      question: type === 'word' ? 'خمّن الكلمة' : form.question.value.trim().slice(0, 1000) || (type === 'photo' ? 'رتّب أجزاء الصورة' : ''),
      type,
      options,
      ...(type === 'photo' ? { grid, scramble: keepScramble ? edit.scramble : makeScramble(grid) } : {}),
      ...(type === 'word' ? { length: Number(form.wordLength.value) } : {}),
      hints: type === 'word' ? [] : hints,
      author: me.displayName,
      by: me.username,
      ...(edit ? { edits: edit.id } : {}),
      ...(edit && missing.length && answers.length && type === editType ? { keepHashes: missing } : {}),
    };
    submitBtn.disabled = true;
    try {
      const pics = {};
      for (const [key, label] of [['q', 'صورة السؤال'], ['a', 'صورة الإجابة']]) {
        if (!files[key]) continue;
        submitBtn.textContent = '⏳ جارٍ رفع الصور…';
        const pic = await shrinkPicture(files[key]).catch(() => null);
        if (!pic) throw new Error(`${label} ليست صورة صالحة.`);
        if (pic.bytes.length > 2 * 1024 * 1024) throw new Error(`${label} كبيرة جدًا. اختر صورة أصغر.`);
        pics[key] = pic;
      }
      submitBtn.textContent = '⏳ جارٍ الحفظ…';
      if (direct) {
        // The admin: straight into the game.
        const pick = (key) => (pics[key] ? { bytes: Promise.resolve(pics[key].bytes.buffer), ext: pics[key].ext } : edit ? (removed[key] ? null : undefined) : null);
        await savePuzzle({ ...entry, id: 'p-' + Date.now().toString(36) + randomHex(2) }, answers, { q: pick('q'), a: pick('a') });
        await refreshData();
      } else {
        const id = edit ? edit.id : 'p-' + Date.now().toString(36) + randomHex(2);
        const key = edit ? 'edit-' + edit.id : id;
        const tag = edit ? Date.now().toString(36) : '';
        const images = {};
        for (const k of ['q', 'a']) {
          if (!pics[k]) continue;
          const path = `pending/${id}${tag ? '-' + tag : ''}-${k}.${pics[k].ext}`;
          await savesPutFile(cfg, path, pics[k].bytes, `Puzzle picture from ${me.username}`);
          images[k] = path;
        }
        await updateSaves(cfg, (all) => {
          all[key] = {
            ...entry,
            id,
            // Lightly scrambled so the answers aren't sitting there in plain text.
            answersHidden: answers.length ? hideKey(JSON.stringify(answers)) : null,
            images,
            ...(edit ? { remove: removed } : {}),
            submittedAt: new Date().toISOString(),
          };
        }, `${edit ? 'Puzzle changes' : 'Puzzle'} from ${me.username}`, PENDING_FILE);
      }
    } catch (e2) {
      submitBtn.disabled = false;
      submitBtn.textContent = btnLabel;
      return showMsg(err, /^(upload|saves)/.test(e2.message) ? 'تعذّر الإرسال. تحقق من الإنترنت وحاول مرة أخرى.' : e2.message);
    }
    mount('t-code');
    app.querySelector('#c-after').textContent = '';
    if (direct) {
      app.querySelector('#c-title').textContent = '✅ تم الحفظ';
      app.querySelector('#c-text').textContent = 'يظهر في اللعبة خلال دقيقة تقريبًا.';
    } else if (edit) {
      app.querySelector('#c-title').textContent = '✅ وصلت تعديلاتك!';
      app.querySelector('#c-text').textContent = 'أُرسلت تعديلاتك إلى المشرف. يبقى لغزك كما هو حتى يوافق عليها.';
    } else {
      app.querySelector('#c-title').textContent = '✅ وصل لغزك!';
      app.querySelector('#c-text').textContent = 'أُرسل لغزك إلى المشرف، وسيظهر في اللعبة بعد موافقته. تحصل على جوهرة هدية عند قبوله.';
    }
    app.querySelector('#c-back').textContent = !edit ? 'أضف لغزًا آخر' : location.hash === '#admin' ? 'Back to Admin' : 'ارجع إلى ملفي';
    app.querySelector('#c-back').onclick = () => {
      if (!edit) return submit();
      if (location.hash === '#admin' || location.hash === '#profile') return route();
      location.hash = '#profile';
    };
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
  $('#pr-solved').textContent = myPuzzles().filter((p) => progress.solved.includes(p.id)).length;
  $('#pr-live').textContent = mine.length;
  $('#pr-pending').textContent = '…';
  const cfg0 = savesConfig(settings);
  if (cfg0) {
    readSaves(cfg0, PENDING_FILE)
      .then(({ data }) => {
        const waiting = Object.values(data).filter((x) => x.by === me.username);
        $('#pr-pending').textContent = waiting.filter((x) => !x.edits).length;
        waiting.filter((x) => x.edits && editNotes[x.edits]).forEach((x) => (editNotes[x.edits].textContent = '⏳ تعديلاتك بانتظار موافقة المشرف'));
      })
      .catch(() => ($('#pr-pending').textContent = '—'));
  } else $('#pr-pending').textContent = '—';

  // Leaderboard choices: show as "مجهول", or leave the leaderboard entirely.
  const choice = (box, msg, field, yes, no) => {
    box.checked = !!(saves[me.username] || {})[field];
    box.onchange = async () => {
      const cfg = savesConfig(settings);
      if (!cfg) {
        box.checked = !box.checked;
        return (msg.textContent = 'غير متاح بعد. اطلب من المشرف تفعيل الحفظ.');
      }
      box.disabled = true;
      msg.textContent = '⏳ جارٍ الحفظ…';
      const value = box.checked;
      try {
        saves = await updateSaves(cfg, (all) => {
          all[me.username] = { ...all[me.username], [field]: value };
        }, `Leaderboard: ${me.username}`);
        msg.textContent = value ? yes : no;
      } catch {
        box.checked = !value;
        msg.textContent = 'تعذّر الحفظ. تحقق من الإنترنت وحاول مرة أخرى.';
      } finally {
        box.disabled = false;
      }
    };
  };
  choice($('#pr-anon'), $('#pr-anon-msg'), 'anonymous', 'تم ✓ تظهر في لوحة المتصدرين باسم "مجهول".', 'تم ✓ يظهر اسمك في لوحة المتصدرين.');
  choice($('#pr-hide'), $('#pr-hide-msg'), 'hideFromBoard', 'تم ✓ لن تظهر في لوحة المتصدرين.', 'تم ✓ عدت إلى لوحة المتصدرين.');
  $('#pr-jewels-why').textContent = 'تحصل على جوهرتين لكل لغز تحله، وجوهرة هدية لكل لغز من ألغازك يُقبل في اللعبة. التلميح الصغير يكلّف جوهرتين، والكبير ٤ جواهر، وتأجيل اللغز جوهرة واحدة. في "العب كلمات" كل كلمة بجوهرة، وحلّها يعطيك جوهرتين.';
  const taken = Number((saves[me.username] || {}).deducted) || 0;
  if (taken > 0) $('#pr-jewels-why').textContent += ` خصم المشرف من جواهرك ${taken} 💎.`;
  if (taken < 0) $('#pr-jewels-why').textContent += ` أهداك المشرف ${-taken} 💎.`;

  const list = $('#pr-puzzles');
  if (!mine.length) list.append(el('li', { className: 'empty muted', textContent: 'لم يُقبل لك لغز بعد. أضف لغزًا من صفحة "أضف لغزًا".' }));
  const editNotes = {};
  mine.forEach((p) => {
    editNotes[p.id] = el('div', { className: 'meta' });
    list.append(el('li', {},
      el('div', { textContent: p.question, style: 'white-space:pre-wrap;font-weight:600', dir: 'auto' }),
      el('div', { className: 'meta', textContent: `🎁 +${PUZZLE_GIFT} 💎 · ${p.addedAt || ''}` }),
      editNotes[p.id],
      el('div', { className: 'row' }, el('button', { type: 'button', textContent: '✏️ عدّل', onclick: () => submit(p) }))));
  });

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
    const [u, p, s, g] = await loadData();
    users = u;
    puzzles = p;
    settings = s || {};
    groups = withDefaultGroup(g);
  } catch {}
  const cfg = savesConfig(settings);
  if (cfg) {
    try {
      saves = (await readSaves(cfg)).data;
    } catch {}
  }
}

async function leaderboardView() {
  const was = app.querySelector('#board-group');
  const keep = was && was.value;
  mount('t-leaderboard');
  if (keep) app.querySelector('#board-group').dataset.keep = keep;
  const board = app.querySelector('#board');
  await refreshData();
  if (location.hash !== '#leaderboard') return; // they moved on while it loaded
  // My own progress on this device is the freshest.
  const mineNow = { ...saves, [me.username]: { ...saves[me.username], ...loadProgress() } };
  // Each group has its own leaderboard. The admin can look at any group's.
  const pickGroup = app.querySelector('#board-group');
  if (me.admin && !pickGroup.options.length) {
    const want = pickGroup.dataset.keep || myGroup();
    pickGroup.append(...groups.map((g) => el('option', { value: g.id, textContent: g.name, selected: g.id === want })));
    app.querySelector('#board-group-box').hidden = groups.length < 2;
    pickGroup.onchange = leaderboardView;
  }
  const group = me.admin && pickGroup.value ? pickGroup.value : myGroup();
  const all = leaderboard(users, puzzles, mineNow, group, groups);
  // Players who left the leaderboard don't show or take a rank.
  const rows = all.filter((r) => !r.hidden);
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
      el('span', { className: 'stats', textContent: `✅ ${r.solved} · 💎 ${r.jewels} · 🧩 ${r.live}` })));
  });
  const hidden = all.filter((r) => r.hidden);
  const note = app.querySelector('#board-hidden');
  if (hidden.some((r) => r.username === me.username)) note.textContent = 'أنت مخفي من لوحة المتصدرين. تستطيع الرجوع من ملفي.';
  if (me.admin && hidden.length) note.textContent = `مخفيون من اللوحة (يراهم المشرف فقط): ${hidden.map((r) => r.name).join('، ')}`;
  note.hidden = !note.textContent;
}

// ---------- start ----------

// The admin's device reads straight from GitHub so changes show at once;
// everyone else reads the published site files.
async function loadData() {
  if (getKey()) {
    try {
      const [u, p, s, g] = await Promise.all([readRepoJson('users'), readRepoJson('puzzles'), readRepoJson('settings'), readRepoJson('groups')]);
      return [u.data, p.data, s.data, g.data];
    } catch {}
  }
  return Promise.all([
    loadJson('data/users.json'),
    loadJson('data/puzzles.json'),
    loadJson('data/settings.json').catch(() => ({})),
    loadJson('data/groups.json').catch(() => []),
  ]);
}

loadData()
  .then(async ([u, p, s, g]) => {
    users = u;
    puzzles = p;
    settings = s || {};
    groups = withDefaultGroup(g);
    let saved = null;
    try { saved = localStorage.getItem('sawg-user'); } catch {}
    me = users.find((x) => x.username === saved && x.status === 'active') || null;
    if (me) await syncDown();
    route();
  })
  .catch((e) => app.replaceChildren(el('p', { className: 'error', textContent: e.message })));

// ---------- "العب كلمات": a word for 1 jewel ----------
// Each word costs WORDLE_COST; solving it gives WORDLE_REWARD whatever its
// length (3, 4, 6 or 7 letters, picked at random). progress.wordle =
// { bought, won, cur } where cur is the word in play (scrambled), so leaving
// the page or reloading keeps the same word and doesn't charge again.
function wordsPage() {
  mount('t-words');
  const $ = (s) => app.querySelector(s);
  const progress = loadProgress();
  const w = progress.wordle;
  const fb = $('#w-feedback');
  const err = $('#w-error');
  const buy = $('#w-buy');
  const game = $('#w-game');
  const show = () => {
    $('#w-jewels').textContent = `💎 ${jewels(progress)}`;
    $('#w-stats').textContent = `✅ حللت ${w.won || 0} من ${w.bought || 0}`;
  };
  const finish = () => {
    w.cur = null;
    saveProgress(progress);
    show();
    buy.hidden = false;
  };
  const lengthOf = (cur) => {
    try {
      return wordLetters(revealKey(cur.s)).length;
    } catch {
      return 0;
    }
  };
  const start = (cur) => {
    buy.hidden = true;
    showMsg(err, '');
    const anchor = el('div');
    game.replaceChildren(anchor);
    wordGame({ id: 'wordle', length: lengthOf(cur) }, false, progress, anchor, fb, () => {
      w.won = (w.won || 0) + 1;
      fb.hidden = false;
      fb.className = 'feedback ok';
      fb.textContent = `✅ أحسنت! +${WORDLE_REWARD} 💎`;
      finish();
    }, {
      saved: cur,
      reward: WORDLE_REWARD,
      save: (state) => {
        w.cur = state;
        saveProgress(progress);
      },
      onLose: finish,
    });
  };

  buy.onclick = async () => {
    showMsg(err, '');
    if (jewels(progress) < WORDLE_COST) return showMsg(err, 'ليس لديك جواهر كافية. حلّ ألغازًا في صفحة "العب" لتكسب جواهر.');
    buy.disabled = true;
    const list = await loadWords().catch(() => []);
    buy.disabled = false;
    if (!buy.isConnected || w.cur) return;
    const lengths = WORDLE_LENGTHS.filter((n) => list.some((x) => wordLetters(x).length === n));
    if (!lengths.length) return showMsg(err, 'لا توجد كلمات في القاموس بعد.');
    const n = lengths[Math.floor(Math.random() * lengths.length)];
    const pool = list.filter((x) => wordLetters(x).length === n);
    w.bought = (w.bought || 0) + 1;
    w.cur = { s: hideKey(pool[Math.floor(Math.random() * pool.length)]), g: [] };
    fb.hidden = true;
    saveProgress(progress);
    show();
    start(w.cur);
  };

  show();
  if (w.cur && Array.isArray(w.cur.g) && WORDLE_LENGTHS.includes(lengthOf(w.cur))) start(w.cur);
  else w.cur = null;
}

// ---------- guess the word ----------

function wordLength(p) {
  return Math.min(WORD_MAX, Math.max(WORD_MIN, Number(p.length) || 5));
}

const WORD_KEYS = [
  ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج'],
  ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط'],
  ['ذ', 'ء', 'ئ', 'ؤ', 'ر', 'ى', 'ة', 'و', 'ز', 'ظ', 'د'],
];

// A random word of the puzzle's length; 6 tries; after 6 misses the player
// starts again with a new word. The word in play is kept in the progress
// (lightly scrambled) so reloading doesn't give a new one.
// opts (the paid word game page): saved = the word in play, save(state)
// keeps it, onLose() instead of the free "new word" button, intro text.
function wordGame(p, practice, progress, before, fb, onWin, opts = {}) {
  const n = wordLength(p);
  const box = el('div', { className: 'word-game' });
  const grid = el('div', { className: 'word-grid' });
  grid.style.maxWidth = `${n * 62}px`;
  const keys = el('div', { className: 'word-keys' });
  const again = el('button', { type: 'button', className: 'primary', textContent: '🔄 كلمة جديدة', hidden: true });
  box.append(grid, again, keys);
  before.before(
    el('p', { className: 'muted small', textContent: `خمّن الكلمة المكونة من ${n} أحرف. لديك ${WORD_GUESSES} محاولات. 🟩 الحرف في مكانه · 🟧 الحرف في الكلمة بمكان آخر · ⬛ الحرف ليس في الكلمة. المكافأة: ${opts.reward != null ? opts.reward : n - 1} 💎` }),
    box,
  );
  grid.textContent = '⏳';

  let words = [];
  let state = null; // { s: scrambled word, g: [guesses] }
  let typed = [];
  let over = false;
  const secret = () => {
    try {
      return revealKey(state.s);
    } catch {
      return '';
    }
  };
  const save = () => {
    if (practice) return;
    if (opts.save) return opts.save(state);
    progress.word[p.id] = state;
    saveProgress(progress);
  };
  const fresh = (avoid) => {
    const pool = words.filter((w) => wordLetters(w).length === n && w !== avoid);
    const all = pool.length ? pool : words.filter((w) => wordLetters(w).length === n);
    if (!all.length) return null;
    return { s: hideKey(all[Math.floor(Math.random() * all.length)]), g: [] };
  };
  const say = (text, ok) => {
    fb.hidden = !text;
    fb.className = 'feedback ' + (ok ? 'ok' : 'bad');
    fb.textContent = text || '';
  };

  const draw = () => {
    const word = secret();
    const rows = [];
    const keyState = {};
    const rank = { no: 1, near: 2, ok: 3 };
    for (let r = 0; r < WORD_GUESSES; r++) {
      const guess = state.g[r];
      const letters = guess ? [...guess] : r === state.g.length && !over ? typed : [];
      const marks = guess ? scoreGuess(guess, word) : [];
      if (guess) letters.forEach((c, i) => {
        const k = wordLetters(c).join('');
        if (!keyState[k] || rank[marks[i]] > rank[keyState[k]]) keyState[k] = marks[i];
      });
      const row = el('div', { className: 'word-row' });
      row.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      for (let i = 0; i < n; i++) row.append(el('span', { className: 'word-tile' + (marks[i] ? ' ' + marks[i] : letters[i] ? ' filled' : ''), textContent: letters[i] || '' }));
      rows.push(row);
    }
    grid.replaceChildren(...rows);
    keys.replaceChildren(
      ...WORD_KEYS.map((line) => el('div', { className: 'word-key-row' }, ...line.map((k) => {
        const b = el('button', { type: 'button', className: 'word-key ' + (keyState[wordLetters(k).join('')] || ''), textContent: k });
        b.onclick = () => press(k);
        return b;
      }))),
      el('div', { className: 'word-key-row' },
        Object.assign(el('button', { type: 'button', className: 'word-key wide primary', textContent: 'إدخال' }), { onclick: () => press('Enter') }),
        Object.assign(el('button', { type: 'button', className: 'word-key wide', textContent: '⌫' }), { onclick: () => press('Backspace') })),
    );
    keys.hidden = over;
  };

  const lost = () => {
    over = true;
    keys.hidden = true;
    if (opts.onLose) {
      say(`❌ انتهت المحاولات. الكلمة كانت: ${secret()}`);
      return opts.onLose();
    }
    say(`❌ انتهت المحاولات. الكلمة كانت: ${secret()}. جرّب كلمة جديدة!`);
    again.hidden = false;
  };

  const press = (k) => {
    if (over) return;
    if (k === 'Backspace') typed.pop();
    else if (k === 'Enter') {
      if (typed.length < n) return say(`اكتب ${n} أحرف.`);
      const guess = typed.join('');
      typed = [];
      state.g.push(guess);
      save();
      if (scoreGuess(guess, secret()).every((m) => m === 'ok')) {
        over = true;
        draw();
        return onWin();
      }
      if (state.g.length >= WORD_GUESSES) {
        draw();
        return lost();
      }
      say('');
    } else if (typed.length < n && /^[ء-ي]$/.test(k)) typed.push(k);
    draw();
  };

  again.onclick = () => {
    state = fresh(secret());
    typed = [];
    over = false;
    again.hidden = true;
    say('');
    save();
    draw();
  };

  // A computer keyboard works too.
  const onKey = (e) => {
    if (!box.isConnected) return document.removeEventListener('keydown', onKey);
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) return;
    if (e.key === 'Enter' || e.key === 'Backspace' || /^[ء-ي]$/.test(e.key)) {
      e.preventDefault();
      press(e.key);
    }
  };
  document.addEventListener('keydown', onKey);

  loadWords().then((list) => {
    words = list;
    if (!box.isConnected) return;
    const saved = opts.saved || (!practice && progress.word[p.id]);
    state = saved && Array.isArray(saved.g) ? saved : null;
    try {
      if (state && wordLetters(revealKey(state.s)).length !== n) state = null; // the admin changed the length
    } catch {
      state = null;
    }
    if (!state) {
      state = fresh();
      if (!state) {
        grid.textContent = 'لا توجد كلمات بهذا الطول في القاموس بعد.';
        keys.hidden = true;
        return;
      }
      save();
    }
    draw();
    if (state.g.length && scoreGuess(state.g[state.g.length - 1], secret()).every((m) => m === 'ok')) {
      over = true;
      draw();
      onWin();
    } else if (state.g.length >= WORD_GUESSES) lost();
  });
}
