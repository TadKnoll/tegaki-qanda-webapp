(function () {
  'use strict';

  // 選択式バージョン: マスに書くと候補文字を表示し、解答者が選んで確定する。
  // 採点は「選択した文字」と正解の照合のみ（CNN確率判定は使わない）。
  var bankId = 'history';
  var qIndex = 0;
  var cellTotal = 0;      // 表示しているマスの総数（固定。正解文字数より多い）
  var activeCell = -1;
  var candCell = -1;      // 候補パネルを表示しているマスの index（-1 = 非表示）
  var candAll = [];       // 全候補（確率順・重複なし）
  var candShown = 0;      // 現在表示している候補数
  var candPageSize = 8;   // 1回に増やす数
  var candMax = 32;       // 候補の表示上限
  var banks = QuizStore.load();

  // ---- 採点時の正規化（小書き仮名の読み替えと記号の無視） ----
  var SYMBOLS = '\u30FB\uFF1D\u30FC\u2010\u002D\u2015\u301C\uFF5E'; // ・ ＝ ー ‐ - ― 〜 ～
  var SMALL_TO_LARGE = {
    '\u3041': '\u3042', '\u3043': '\u3044', '\u3045': '\u3046',
    '\u3047': '\u3048', '\u3049': '\u304A', '\u3063': '\u3064',
    '\u3083': '\u3084', '\u3085': '\u3086', '\u3087': '\u3088',
    '\u308E': '\u308F', '\u30A1': '\u30A2', '\u30A3': '\u30A4',
    '\u30A5': '\u30A6', '\u30A7': '\u30A8', '\u30A9': '\u30AA',
    '\u30C3': '\u30C4', '\u30E3': '\u30E4', '\u30E5': '\u30E6',
    '\u30E7': '\u30E8', '\u30EE': '\u30EF', '\u30F5': '\u30AB',
    '\u30F6': '\u30B1'
  };
  function isSymbol(c) {
    return SYMBOLS.indexOf(c) >= 0;
  }
  function normalizeChar(c) {
    return SMALL_TO_LARGE[c] || c;
  }
  // 記号を省き、小書き仮名を大書きに揃えて比較可能な文字列にする
  function normalizeText(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (isSymbol(c)) continue;
      out += normalizeChar(c);
    }
    return out;
  }

  var qnumEl = document.getElementById('qnum');
  var qEl = document.getElementById('question-text');
  var cellsEl = document.getElementById('cells');
  var resultEl = document.getElementById('result');
  var candPanel = document.getElementById('cand-panel');
  var candTitle = document.getElementById('cand-title');
  var candListEl = document.getElementById('cand-list');
  var undoBtn = document.getElementById('undo-btn');
  var clearBtn = document.getElementById('clear-btn');
  var gradeBtn = document.getElementById('grade-btn');

  var confirmed = [];      // 各マスで確定した文字（未確定は ''）
  var candTimers = [];     // マスごとの候補表示デバウンス
  var busy = false;        // 候補計算中

  function current() {
    return banks[bankId].questions[qIndex];
  }
  function listLength() {
    return banks[bankId].questions.length;
  }
  function cellId(i) {
    return 'c' + i;
  }
  function maxCells() {
    return Math.max(banks[bankId].maxCells || 0, current().a.length);
  }
  function cnnAvailable() {
    return window.CNN && CNN.available;
  }
  function cellStrokes(i) {
    return KanjiCanvas['recordedPattern_' + cellId(i)] || [];
  }
  function validStrokes(s) {
    if (!s || !s.length) return false;
    var n = 0;
    for (var i = 0; i < s.length; i++) n += (s[i] || []).length;
    return n >= 2;
  }

  function loadQuestion() {
    var q = current();
    qnumEl.textContent = '問題 ' + (qIndex + 1) + ' / ' + listLength();
    qEl.textContent = q.q;
    cellsEl.innerHTML = '';
    resultEl.innerHTML = '';
    hideCands();
    confirmed = [];
    gradeBtn.disabled = false;
    buildCells();
    setActive(0);
  }

  function buildCells() {
    cellTotal = maxCells();
    for (var i = 0; i < cellTotal; i++) {
      (function (idx) {
        var div = document.createElement('div');
        div.className = 'cell' + (idx === 0 ? ' active' : '');
        div.id = 'cellbox_' + idx;
        var c = document.createElement('canvas');
        c.id = cellId(idx);
        c.width = 110;
        c.height = 110;
        div.appendChild(c);
        div.addEventListener('click', function () { setActive(idx); });
        cellsEl.appendChild(div);
        KanjiCanvas.init(cellId(idx));
        // kanji-canvas は init() 時に touch/mouse を登録済み。
        // この後ろに登録すると、ペンが離れた時点で recordedPattern が更新済み。
        c.addEventListener('touchstart', function () { resetGradedState(); setActive(idx); });
        c.addEventListener('mousedown', function () { resetGradedState(); setActive(idx); });
        c.addEventListener('touchend', function () { scheduleCands(idx); });
        c.addEventListener('mouseup', function () { scheduleCands(idx); });
        c.addEventListener('mouseout', function () { scheduleCands(idx); });
      })(i);
    }
  }

  function setActive(i) {
    activeCell = i;
    var boxes = cellsEl.querySelectorAll('.cell');
    for (var k = 0; k < boxes.length; k++) {
      boxes[k].classList.toggle('active', k === activeCell);
    }
  }

  function clearMarks() {
    var m = cellsEl.querySelectorAll('.mark, .shown');
    for (var i = 0; i < m.length; i++) m[i].remove();
  }

  function resetGradedState() {
    resultEl.innerHTML = '';
    gradeBtn.disabled = false;
    clearMarks();
  }

  function eraseCurrent() {
    if (activeCell < 0) return;
    KanjiCanvas.erase(cellId(activeCell));
    confirmed[activeCell] = '';
    renderConfirm(activeCell);
    hideCands();
    resetGradedState();
  }

  function clearAll() {
    for (var i = 0; i < cellTotal; i++) {
      KanjiCanvas.erase(cellId(i));
      confirmed[i] = '';
      renderConfirm(i);
    }
    hideCands();
    resetGradedState();
  }

  // ---- 候補表示（書いた字からトップ候補を出し、解答者が選んで確定） ----
  function scheduleCands(idx) {
    clearTimeout(candTimers[idx]);
    candTimers[idx] = setTimeout(function () {
      if (busy) { scheduleCands(idx); return; }
      showCands(idx);
    }, 250);
  }

  function renderCandPanel(idx) {
    candListEl.innerHTML = '';
    if (!candAll.length) {
      candListEl.innerHTML = '<span class="cand-loading">候補がありません。書き直してください。</span>';
      return;
    }
    var show = Math.min(candShown, candAll.length, candMax);
    for (var i = 0; i < show; i++) {
      (function (ch) {
        var b = document.createElement('button');
        b.className = 'btn cand-btn';
        b.textContent = ch;
        b.addEventListener('click', function () { pickCandidate(idx, ch); });
        candListEl.appendChild(b);
      })(candAll[i]);
    }
    var symRow = document.createElement('div');
    symRow.className = 'cand-symbols';
    ['\u30FB', '\uFF1D', '\u30FC'].forEach(function (ch) { // ・ ＝ ー
      var b = document.createElement('button');
      b.className = 'btn cand-sym';
      b.textContent = ch;
      b.addEventListener('click', function () { pickCandidate(idx, ch, true); });
      symRow.appendChild(b);
    });
    candListEl.appendChild(symRow);
    if (show < candAll.length && show < candMax) {
      var more = document.createElement('button');
      more.className = 'btn cand-more';
      more.textContent = '▼ 候補をさらに表示';
      more.addEventListener('click', function () {
        candShown += candPageSize;
        renderCandPanel(idx);
      });
      candListEl.appendChild(more);
    }
    var cl = document.createElement('button');
    cl.className = 'btn cand-clear';
    cl.textContent = '✕ 確定しない';
    cl.addEventListener('click', function () { clearConfirmation(idx); });
    candListEl.appendChild(cl);
  }

  function showCands(idx) {
    var strokes = cellStrokes(idx);
    if (!validStrokes(strokes)) { hideCands(); return; }
    candCell = idx;
    candPanel.hidden = false;
    candTitle.textContent = 'マス' + (idx + 1) + ' の候補（書いた字を選んで確定）';
    if (!cnnAvailable()) {
      candListEl.innerHTML = '<span class="cand-loading">認識エンジンを読み込み中…</span>';
      return;
    }
    busy = true;
    candListEl.innerHTML = '<span class="cand-loading">認識中…</span>';
    CNN.recognize(strokes, candMax).then(function (res) {
      candAll = [];
      var seen = {};
      res.top.forEach(function (t) {
        if (!t.label || seen[t.label]) return;
        seen[t.label] = true;
        candAll.push(t.label);
      });
      candShown = candPageSize;
      renderCandPanel(idx);
    }).catch(function () {
      candListEl.innerHTML = '<span class="cand-loading">認識に失敗しました。書き直してください。</span>';
    }).then(function () { busy = false; });
  }

  function hideCands() {
    candCell = -1;
    candPanel.hidden = true;
  }

  function pickCandidate(idx, ch, noSample) {
    confirmed[idx] = ch;
    renderConfirm(idx);
    hideCands();
    resetGradedState();
    if (!noSample && addSample(ch, cellStrokes(idx))) refreshCollectBar();
    // 次の未確定マスへ自動移動
    for (var i = idx + 1; i < cellTotal; i++) {
      if (!confirmed[i]) { setActive(i); return; }
    }
    setActive(idx);
  }

  function clearConfirmation(idx) {
    confirmed[idx] = '';
    renderConfirm(idx);
    hideCands();
  }

  function renderConfirm(idx) {
    var box = document.getElementById('cellbox_' + idx);
    if (!box) return;
    var old = box.querySelector('.cell-confirm');
    if (old) old.remove();
    if (confirmed[idx]) {
      var s = document.createElement('div');
      s.className = 'cell-confirm';
      s.textContent = confirmed[idx];
      box.appendChild(s);
    }
  }

  // ---- 採点（選択した文字と正解の照合） ----
  function grade() {
    var q = current();
    gradeBtn.disabled = true;
    resultEl.innerHTML = '';
    hideCands();
    var results = [];
    for (var i = 0; i < cellTotal; i++) {
      var expected = i < q.a.length ? q.a[i] : '';
      if (!expected) { results.push({ grade: 'blank', shown: '' }); continue; }
      if (isSymbol(expected)) { results.push({ grade: 'blank', shown: '' }); continue; }
      if (!confirmed[i]) { results.push({ grade: 'ng', shown: '未記入' }); continue; }
      var ok = normalizeText(confirmed[i]) === normalizeText(expected);
      results.push({ grade: ok ? 'ok' : 'ng', shown: confirmed[i] });
    }
    showResults(results);
  }

  function showResults(results) {
    renderMarks(results);
    var ok = results.every(function (r) { return r.grade !== 'ng'; });
    var sEl = document.createElement('div');
    sEl.className = 'score ' + (ok ? 'score-ok' : 'score-ng');
    sEl.textContent = ok ? '◯ 正解！' : '× 不正解';
    var f = document.createElement('div');
    f.className = 'feedback';
    f.textContent = '正解は「' + current().a + '」';
    var l = document.createElement('div');
    l.className = 'legend';
    l.textContent = '○=選択した字が正解　×=不正解・未確定';
    resultEl.innerHTML = '';
    resultEl.appendChild(sEl);
    resultEl.appendChild(f);
    resultEl.appendChild(l);
    gradeBtn.disabled = true;
  }

  function renderMarks(results) {
    clearMarks();
    for (var i = 0; i < cellTotal; i++) {
      var box = document.getElementById('cellbox_' + i);
      if (!box || !results[i] || results[i].grade === 'blank') continue;
      var mark = document.createElement('span');
      mark.className = 'mark ' + results[i].grade;
      mark.textContent = results[i].grade === 'ok' ? '○' : '×';
      box.appendChild(mark);
    }
  }

  // ---- 学習データ収集（確定したマスを自動保存 → 再学習用） ----
  var COLLECT_KEY = 'kanji_train_data_v1';

  function loadCollected() {
    try { return JSON.parse(localStorage.getItem(COLLECT_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function saveCollected(list) {
    try { localStorage.setItem(COLLECT_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // 重複を避けつつ1サンプル追加。追加できたら true
  function addSample(ch, strokes) {
    if (!ch || ch.length !== 1 || !validStrokes(strokes)) return false;
    var list = loadCollected();
    var key = JSON.stringify(strokes);
    for (var i = 0; i < list.length; i++) {
      if (list[i].char === ch && JSON.stringify(list[i].strokes) === key) return false;
    }
    list.push({ char: ch, strokes: strokes, t: Date.now() });
    saveCollected(list);
    return true;
  }

  function downloadCollected() {
    var list = loadCollected();
    var blob = new Blob([JSON.stringify(list, null, 0)], { type: 'application/json' });
    var a = document.createElement('a');
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    a.href = URL.createObjectURL(blob);
    a.download = 'kanji_training_data_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  function refreshCollectBar() {
    var bar = document.getElementById('collect-bar');
    if (!bar) return;
    var n = loadCollected().length;
    if (n > 0) {
      bar.hidden = false;
      document.getElementById('collect-count').textContent = '学習用の手書きデータ 保存済み ' + n + ' 件';
    } else {
      bar.hidden = true;
    }
  }

  undoBtn.addEventListener('click', eraseCurrent);
  clearBtn.addEventListener('click', clearAll);
  gradeBtn.addEventListener('click', grade);
  document.getElementById('prev-btn').addEventListener('click', function () {
    qIndex = (qIndex - 1 + listLength()) % listLength();
    loadQuestion();
  });
  document.getElementById('next-btn').addEventListener('click', function () {
    qIndex = (qIndex + 1) % listLength();
    loadQuestion();
  });

  loadQuestion();
  refreshCollectBar();
  var dlBtn = document.getElementById('collect-dl');
  if (dlBtn) dlBtn.addEventListener('click', downloadCollected);

  // CNN モデルを事前読み込み（初回の候補表示を速くする）
  if (cnnAvailable()) {
    setTimeout(function () { CNN.init().catch(function () {}); }, 300);
  }

  // 作問ツールの編集データを使用中なら案内を出す
  var note = document.getElementById('data-note');
  if (note && QuizStore.hasSaved()) {
    note.hidden = false;
    note.textContent = 'この端末の作問ツールで編集した問題を使用しています（配布には questions.js の書き出しが必要です）。';
  }
})();
