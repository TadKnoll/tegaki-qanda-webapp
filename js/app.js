(function () {
  'use strict';

  var bankId = 'history';
  var qIndex = 0;
  var cellTotal = 0;      // 表示しているマスの総数（固定。正解文字数より多い）
  var activeCell = -1;
  var tesseractWorker = null;
  var banks = QuizStore.load();   // 作問ツールの編集データがあればそれを使う

  var tabsEl = document.getElementById('tabs');
  var qnumEl = document.getElementById('qnum');
  var qEl = document.getElementById('question-text');
  var cellsEl = document.getElementById('cells');
  var resultEl = document.getElementById('result');
  var undoBtn = document.getElementById('undo-btn');
  var clearBtn = document.getElementById('clear-btn');
  var gradeBtn = document.getElementById('grade-btn');
  var lastResults = null;      // 直近の採点結果（自己判定で更新するため保持）
  var lastWholeAnswer = false;

  function current() {
    return banks[bankId].questions[qIndex];
  }
  function listLength() {
    return banks[bankId].questions.length;
  }
  function isEnglish() {
    return bankId === 'english';
  }
  function cellId(i) {
    return 'c' + i;
  }
  function maxCells() {
    return Math.max(banks[bankId].maxCells || 0, current().a.length);
  }

  function setupTabs() {
    tabsEl.innerHTML = '';
    Object.keys(banks).forEach(function (bid) {
      var b = banks[bid];
      var btn = document.createElement('button');
      btn.className = 'tab' + (bid === bankId ? ' active' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', function () {
        bankId = bid;
        qIndex = 0;
        loadQuestion();
      });
      tabsEl.appendChild(btn);
    });
  }

  function loadQuestion() {
    var q = current();
    qnumEl.textContent = '問題 ' + (qIndex + 1) + ' / ' + listLength();
    qEl.textContent = q.q;
    cellsEl.innerHTML = '';
    resultEl.innerHTML = '';
    gradeBtn.disabled = false;
    buildCells(q.a);
    setActive(0);
  }

  function buildCells(answer) {
    if (isEnglish()) {
      cellTotal = 1;
      var wide = document.createElement('div');
      wide.className = 'cell cell-wide';
      wide.id = 'cellbox_0';
      var cv = document.createElement('canvas');
      cv.id = cellId(0);
      cv.width = 560;
      cv.height = 150;
      wide.appendChild(cv);
      cellsEl.appendChild(wide);
      KanjiCanvas.init(cellId(0));
    } else {
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
        })(i);
      }
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
    KanjiCanvas.deleteLast(cellId(activeCell));
    resetGradedState();
  }

  function clearAll() {
    for (var i = 0; i < cellTotal; i++) KanjiCanvas.erase(cellId(i));
    resetGradedState();
  }

  // ---- CNN 採点（onnxruntime-web） ----
  // 正解既知の閉集合を利用し、CNN softmax 確率で ○/△/× を判定する。
  // 実手書きと合成学習データの乖離に備え、自信が無い場合は △（自己判定）に回す。
  var CNN_OK_P = 0.5;     // top1==正解 かつ この確率以上なら ○
  var CNN_AMB_P = 0.25;   // 正解がこの確率以上なら △（top1が正解でなくても候補扱い）

  function cnnAvailable() {
    return window.CNN && CNN.available;
  }

  function gradeCellCNN(cell) {
    var expected = cell.expected;
    var strokes = cell.strokes;
    if (!expected) {
      return Promise.resolve({ grade: strokes.length ? 'ng' : 'blank', shown: '', answer: '', cands: [] });
    }
    if (!strokes.length) {
      return Promise.resolve({ grade: 'ng', shown: '未記入', answer: expected, cands: [] });
    }
    return CNN.recognize(strokes, 5).then(function (res) {
      var cands = res.top.map(function (t) { return t.label; });
      var ei = CNN.indexOf(expected);
      var pExp = ei >= 0 ? (res.probs[ei] || 0) : -1;
      var top1 = res.top[0];
      var shown = top1 ? top1.label : '';
      if (ei < 0) {
        // モデルに含まれない文字は自動判定せず自己判定に回す
        return { grade: 'good', shown: shown, answer: expected, cands: cands };
      }
      if (top1 && top1.label === expected) {
        return { grade: top1.prob >= CNN_OK_P ? 'ok' : 'good', shown: shown, answer: expected, cands: cands };
      }
      if (cands.indexOf(expected) >= 0 || pExp >= CNN_AMB_P) {
        return { grade: 'good', shown: shown, answer: expected, cands: cands };
      }
      return { grade: 'ng', shown: shown, answer: expected, cands: cands };
    });
  }

  function grade() {
    if (isEnglish()) { gradeEnglish(); return; }
    var q = current();
    var wholeAnswer = !!banks[bankId].wholeAnswer;
    if (!cnnAvailable()) {
      resultEl.innerHTML = '<div class="feedback">CNN認識（onnxruntime-web）を読み込めませんでした。httpサーバー経由で開いてください。</div>';
      return;
    }
    gradeBtn.disabled = true;
    resultEl.innerHTML = '<div class="feedback">認識中…</div>';
    // ort-wasm の同一セッションへの同時 run() はデッドロックするため直列で実行する
    var results = [];
    var chain = Promise.resolve();
    for (var i = 0; i < cellTotal; i++) {
      (function (idx) {
        chain = chain.then(function () {
          var expected = idx < q.a.length ? q.a[idx] : '';
          var strokes = KanjiCanvas['recordedPattern_' + cellId(idx)] || [];
          return gradeCellCNN({ expected: expected, strokes: strokes });
        }).then(function (r) { results.push(r); });
      })(i);
    }
    chain.then(function () {
      showResults(results, wholeAnswer);
    }).catch(function (err) {
      resultEl.innerHTML = '<div class="feedback">認識に失敗しました: ' + (err && err.message ? err.message : err) + '</div>';
      gradeBtn.disabled = false;
    });
  }

  // ---- 学習データ収集（実手書きを溜めて再学習するための保存/ダウンロード） ----
  var COLLECT_KEY = 'kanji_train_data_v1';

  function loadCollected() {
    try { return JSON.parse(localStorage.getItem(COLLECT_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function saveCollected(list) {
    try { localStorage.setItem(COLLECT_KEY, JSON.stringify(list)); } catch (e) {}
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

  // ◯判定のマスをまとめて保存（正しい手書き＝正解ラベルとして学習に使える）
  function collectOkSamples() {
    var q = current();
    var added = 0;
    for (var i = 0; i < lastResults.length; i++) {
      if (!lastResults[i] || lastResults[i].grade !== 'ok') continue;
      var ch = i < q.a.length ? q.a[i] : '';
      if (addSample(ch, cellStrokes(i))) added++;
    }
    return added;
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

  function englishWhitelist() {
    var set = {};
    var qs = (banks.english && banks.english.questions) || [];
    qs.forEach(function (q) {
      String(q.a).toLowerCase().replace(/[a-z]/g, function (c) { set[c] = true; });
    });
    return Object.keys(set).sort().join('');
  }

  function gradeEnglish() {
    loadTesseractLib().then(function () {
      if (!tesseractWorker) {
        return Tesseract.createWorker('eng', 1).then(function (w) {
          tesseractWorker = w;
          return w.setParameters({ tessedit_char_whitelist: englishWhitelist() }).then(function () {
            return runEnglish();
          });
        });
      }
      return runEnglish();
    }).catch(function (err) {
      resultEl.innerHTML = '<div class="feedback">英語認識を読み込めませんでした（要インターネット）。' + (err && err.message ? ' ' + err.message : '') + '</div>';
    });
  }

  function runEnglish() {
    var q = current();
    var canvas = document.getElementById(cellId(0));
    return tesseractWorker.recognize(canvas).then(function (r) {
      var text = (r && r.data && r.data.text || '').trim();
      var norm = text.toLowerCase().replace(/[^a-z]/g, '');
      var ans = q.a.toLowerCase();
      var ok = norm === ans || (ans.length > 1 && norm.indexOf(ans) >= 0);
      showResults([{ grade: ok ? 'ok' : 'ng', shown: text || '未記入', answer: q.a }], true);
    });
  }

  function showResults(results, wholeAnswer) {
    lastResults = results;
    lastWholeAnswer = wholeAnswer;
    renderMarks(results);
    var s = scoreInfo(results, wholeAnswer);
    var sEl = document.createElement('div');
    sEl.className = 'score ' + s.cls;
    sEl.textContent = s.text;
    var f = document.createElement('div');
    f.className = 'feedback';
    f.textContent = '正解は「' + current().a + '」';
    resultEl.innerHTML = '';
    resultEl.appendChild(sEl);
    resultEl.appendChild(f);
    if (!wholeAnswer) {
      var l = document.createElement('div');
      l.className = 'legend';
      l.textContent = '○=正解　△=自動判定に自信なし（自分で確認）　×=不正解';
      resultEl.appendChild(l);
    }
    var ambIdx = [];
    for (var i = 0; i < results.length; i++) if (results[i].grade === 'good') ambIdx.push(i);
    if (ambIdx.length) renderSelfCheck(ambIdx);
    gradeBtn.disabled = true;

    // 実手書きの再学習用（英語は対象外）
    if (!isEnglish()) {
      var okN = 0;
      for (var ci = 0; ci < results.length; ci++) {
        if (results[ci] && results[ci].grade === 'ok' && ci < current().a.length && validStrokes(cellStrokes(ci))) okN++;
      }
      if (okN) {
        var cw = document.createElement('div');
        cw.className = 'collect-actions';
        var cb = document.createElement('button');
        cb.className = 'btn';
        cb.textContent = '◯の手書き ' + okN + ' 字を学習用に保存';
        var cmsg = document.createElement('span');
        cmsg.className = 'collect-msg';
        cb.addEventListener('click', function () {
          var added = collectOkSamples();
          cmsg.textContent = added + ' 字を保存しました。画面下の「ダウンロード」で取り出せます。';
          cb.disabled = true;
          refreshCollectBar();
        });
        cw.appendChild(cb);
        cw.appendChild(cmsg);
        resultEl.appendChild(cw);
      }
      // △・×でも「正しく書けた」場合に保存できるよう、マス単位の保存ボタンを出す
      for (var mci = 0; mci < results.length; mci++) {
        var mg = results[mci] ? results[mci].grade : '';
        if (mg !== 'good' && mg !== 'ng') continue;
        var mch = mci < current().a.length ? current().a[mci] : '';
        if (!mch || mch.length !== 1 || !validStrokes(cellStrokes(mci))) continue;
        (function (idx, chr) {
          var mbox = document.createElement('div');
          mbox.className = 'collect-actions';
          var mb = document.createElement('button');
          mb.className = 'btn';
          mb.textContent = 'マス' + (idx + 1) + '「' + chr + '」は正しく書けた → 学習用に保存';
          var mmsg = document.createElement('span');
          mmsg.className = 'collect-msg';
          mb.addEventListener('click', function () {
            var added = addSample(chr, cellStrokes(idx));
            mmsg.textContent = added ? '保存しました。画面下の「ダウンロード」で取り出せます。' : 'この手書きは保存済みです。';
            mb.disabled = true;
            refreshCollectBar();
          });
          mbox.appendChild(mb);
          mbox.appendChild(mmsg);
          resultEl.appendChild(mbox);
        })(mci, mch);
      }
    }
  }

  function renderMarks(results) {
    clearMarks();
    for (var i = 0; i < cellTotal; i++) {
      var box = document.getElementById('cellbox_' + i);
      if (!box || !results[i] || results[i].grade === 'blank') continue;
      var mark = document.createElement('span');
      mark.className = 'mark ' + results[i].grade;
      mark.textContent = results[i].grade === 'ok' ? '○' : results[i].grade === 'good' ? '△' : '×';
      box.appendChild(mark);
      if (results[i].shown) {
        var shown = document.createElement('span');
        shown.className = 'shown';
        shown.textContent = results[i].shown;
        box.appendChild(shown);
      }
    }
  }

  function scoreInfo(results, wholeAnswer) {
    if (wholeAnswer) {
      var ok = results.every(function (r) { return r.grade !== 'ng'; });
      return { text: ok ? '◯ 正解！' : '× 不正解', cls: ok ? 'score-ok' : 'score-ng' };
    }
    var correct = 0;
    for (var i = 0; i < results.length; i++) if (results[i].grade === 'ok') correct++;
    return { text: correct + ' / ' + current().a.length + ' 文字 正解', cls: '' };
  }

  function renderSelfCheck(ambIdx) {
    var panel = document.createElement('div');
    panel.className = 'selfcheck';
    panel.id = 'selfcheck';
    var p = document.createElement('p');
    p.className = 'sc-title';
    p.textContent = '以下のマスは自動判定に自信がありません。見比べて ○/× を選んで下さい。';
    panel.appendChild(p);
    ambIdx.forEach(function (i) {
      var row = document.createElement('div');
      row.className = 'sc-row';
      row.id = 'sc-' + i;
      var cellLabel = document.createElement('span');
      cellLabel.className = 'sc-cell';
      cellLabel.textContent = 'マス' + (i + 1);
      var cands = document.createElement('span');
      cands.className = 'sc-cands';
      cands.textContent = '（候補: ' + (lastResults[i].cands || []).join('・') + '）';
      var okBtn = document.createElement('button');
      okBtn.className = 'btn sc-btn';
      okBtn.textContent = '○ あってる';
      okBtn.addEventListener('click', (function (idx) { return function () { resolveSelfCheck(idx, true); }; })(i));
      var ngBtn = document.createElement('button');
      ngBtn.className = 'btn sc-btn';
      ngBtn.textContent = '× まちがい';
      ngBtn.addEventListener('click', (function (idx) { return function () { resolveSelfCheck(idx, false); }; })(i));
      row.appendChild(cellLabel);
      row.appendChild(cands);
      row.appendChild(okBtn);
      row.appendChild(ngBtn);
      panel.appendChild(row);
    });
    resultEl.appendChild(panel);
  }

  function resolveSelfCheck(i, pass) {
    lastResults[i].grade = pass ? 'ok' : 'ng';
    if (pass) {
      var ch = current().a[i];
      if (ch && ch.length === 1 && addSample(ch, cellStrokes(i))) refreshCollectBar();
    }
    var box = document.getElementById('cellbox_' + i);
    if (box) {
      var oldMark = box.querySelector('.mark');
      if (oldMark) oldMark.remove();
      var oldShown = box.querySelector('.shown');
      if (oldShown) oldShown.remove();
      var mark = document.createElement('span');
      mark.className = 'mark ' + (pass ? 'ok' : 'ng');
      mark.textContent = pass ? '○' : '×';
      box.appendChild(mark);
    }
    var row = document.getElementById('sc-' + i);
    if (row) row.remove();
    var panel = document.getElementById('selfcheck');
    if (panel && panel.querySelectorAll('.sc-row').length === 0) panel.remove();
    var s = scoreInfo(lastResults, lastWholeAnswer);
    var scoreEl = resultEl.querySelector('.score');
    if (scoreEl) { scoreEl.textContent = s.text; scoreEl.className = 'score ' + s.cls; }
  }

  function loadTesseractLib() {
    return new Promise(function (resolve, reject) {
      if (window.Tesseract) { resolve(window.Tesseract); return; }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = function () { resolve(window.Tesseract); };
      s.onerror = function () { reject(new Error('Tesseract.js のCDN読み込みに失敗')); };
      document.head.appendChild(s);
    });
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

  setupTabs();
  loadQuestion();
  refreshCollectBar();
  var dlBtn = document.getElementById('collect-dl');
  if (dlBtn) dlBtn.addEventListener('click', downloadCollected);

  // CNN モデルを事前読み込み（初回採点を速くする）
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