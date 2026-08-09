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

  // 1文字認識。strokeが無ければ null
  function recognizeCell(i) {
    var strokes = KanjiCanvas['recordedPattern_' + cellId(i)] || [];
    if (strokes.length === 0) return null;
    var res = '';
    try { res = KanjiCanvas.recognize(cellId(i)) || ''; } catch (e) { res = ''; }
    return res.trim().split(/\s+/);
  }

  function grade() {
    if (isEnglish()) { gradeEnglish(); return; }
    var q = current();
    var wholeAnswer = !!banks[bankId].wholeAnswer;
    var results = [];
    var correct = 0;
    for (var i = 0; i < cellTotal; i++) {
      var expected = i < q.a.length ? q.a[i] : '';
      var cands = recognizeCell(i);
      if (cands === null) {
        // 空のマス
        results.push({ grade: expected ? 'ng' : 'blank', shown: expected ? '未記入' : '', answer: expected });
      } else {
        var shown = cands[0] || '?';
        if (!expected) {
          // 正解文字数を超えて書いた → 過剰
          results.push({ grade: 'ng', shown: shown, answer: '' });
        } else if (cands[0] === expected) {
          results.push({ grade: 'ok', shown: shown, answer: expected });
          correct++;
        } else if (cands.indexOf(expected) >= 0 && cands.indexOf(expected) < 5) {
          results.push({ grade: 'good', shown: shown, answer: expected });
        } else {
          results.push({ grade: 'ng', shown: shown, answer: expected });
        }
      }
    }
    if (wholeAnswer) {
      // 全マスが ○ か △（×が無い）なら全体を正解とする
      var ok = results.every(function (r) { return r.grade !== 'ng'; });
      showResults(results, ok ? q.a.length : 0, wholeAnswer, ok);
    } else {
      showResults(results, correct, false, false);
    }
  }

  function gradeEnglish() {
    loadTesseractLib().then(function () {
      if (!tesseractWorker) {
        return Tesseract.createWorker('eng', 1).then(function (w) {
          tesseractWorker = w;
          return runEnglish();
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
      showResults([{ grade: ok ? 'ok' : 'ng', shown: text || '未記入', answer: q.a }], ok ? 1 : 0);
    });
  }

  function showResults(results, correct, wholeAnswer, ok) {
    var q = current();
    clearMarks();
    if (!wholeAnswer) {
      // マス毎に ○△× を表示
      for (var i = 0; i < cellTotal; i++) {
        var box = document.getElementById('cellbox_' + i);
        if (!box) continue;
        if (results[i].grade === 'blank') continue; // 余った空マスには何も表示しない
        var mark = document.createElement('span');
        mark.className = 'mark ' + results[i].grade;
        mark.textContent = results[i].grade === 'ok' ? '○' : results[i].grade === 'good' ? '△' : '×';
        box.appendChild(mark);
        var shown = document.createElement('span');
        shown.className = 'shown';
        shown.textContent = results[i].shown;
        box.appendChild(shown);
      }
    }
    var s = document.createElement('div');
    s.className = 'score';
    if (wholeAnswer) {
      s.textContent = ok ? '◯ 正解！' : '× 不正解';
      s.className = 'score ' + (ok ? 'score-ok' : 'score-ng');
    } else {
      s.textContent = correct + ' / ' + q.a.length + ' 文字 正解';
    }
    var f = document.createElement('div');
    f.className = 'feedback';
    f.textContent = '正解は「' + q.a + '」';
    resultEl.innerHTML = '';
    resultEl.appendChild(s);
    resultEl.appendChild(f);
    if (!wholeAnswer) {
      var l = document.createElement('div');
      l.className = 'legend';
      l.textContent = '○=正解　△=候補のうちに含まれる（要確認）　×=不正解';
      resultEl.appendChild(l);
    }
    gradeBtn.disabled = true;
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

  // 作問ツールの編集データを使用中なら案内を出す
  var note = document.getElementById('data-note');
  if (note && QuizStore.hasSaved()) {
    note.hidden = false;
    note.textContent = 'この端末の作問ツールで編集した問題を使用しています（配布には questions.js の書き出しが必要です）。';
  }
})();