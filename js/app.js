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

  // 1文字認識。strokeが無ければ null
  function recognizeCell(i) {
    var strokes = KanjiCanvas['recordedPattern_' + cellId(i)] || [];
    if (strokes.length === 0) return null;
    var res = '';
    try { res = KanjiCanvas.recognize(cellId(i)) || ''; } catch (e) { res = ''; }
    return res.trim().split(/\s+/);
  }

  // ---- 閉集合採点（正解照合モード） ----
  // マスの正解文字が既知であることを利用し、候補を「正解＋似た字＋開放認識の上位」に
  // 限定して距離比較する。画数のフィルタ（ゲート）は使わない。
  var CLOSED_OK_DIST = 36;    // 正解距離の閾値（これ以下なら ○ の候補）
  var CLOSED_OK_MARGIN = 5;   // 正解と最有力の他候補との距離差
  var CLOSED_AMB_DIST = 50;   // ここまでなら △（要自己判定）
  var CLOSED_AMB_MARGIN = 10;

  var refIndex = null;
  function buildRefIndex() {
    refIndex = {};
    for (var k = 0; k < KanjiCanvas.refPatterns.length; k++) {
      var r = KanjiCanvas.refPatterns[k];
      (refIndex[r[0]] = refIndex[r[0]] || []).push(r);
    }
  }

  function refFineDistance(ref, features) {
    var map = KanjiCanvas.getMap(ref[2], features, KanjiCanvas.initialDistance);
    map = KanjiCanvas.completeMap(ref[2], features, KanjiCanvas.wholeWholeDistance, map);
    var d = KanjiCanvas.computeWholeDistanceWeighted(ref[2], features, map);
    return d / Math.min(features.length, ref[2].length);
  }

  function charBestDistance(label, features) {
    var refs = refIndex[label];
    if (!refs) return Infinity;
    var best = Infinity;
    for (var k = 0; k < refs.length; k++) {
      var d = refFineDistance(refs[k], features);
      if (d < best) best = d;
    }
    return best;
  }

  function cellFeatures(i) {
    var id = cellId(i);
    var norm = KanjiCanvas.momentNormalize(id);
    return KanjiCanvas.extractFeatures(norm, 20);
  }

  function closedSetDecision(i, exp) {
    if (!refIndex) buildRefIndex();
    var features = cellFeatures(i);
    var labels = {};
    labels[exp] = true;
    var sims = (window.SIMILAR_CHARS && SIMILAR_CHARS[exp]) || [];
    for (var s = 0; s < sims.length; s++) labels[sims[s]] = true;
    var openTop = recognizeCell(i) || [];
    for (var t = 0; t < openTop.length && t < 3; t++) if (openTop[t]) labels[openTop[t]] = true;
    var scores = [];
    for (var l in labels) scores.push({ label: l, dist: charBestDistance(l, features) });
    scores.sort(function (a, b) { return a.dist - b.dist; });
    var dC = -1, dO = Infinity, oLabel = '';
    for (var u = 0; u < scores.length; u++) {
      if (scores[u].label === exp) dC = scores[u].dist;
      else if (scores[u].dist < dO) { dO = scores[u].dist; oLabel = scores[u].label; }
    }
    var margin = dC - dO;
    var openAgree = openTop.length > 0 && openTop[0] === exp;
    var candLabels = scores.slice(0, 3).map(function (x) { return x.label; });
    if (dC <= CLOSED_OK_DIST && margin <= CLOSED_OK_MARGIN && openAgree) {
      return { grade: 'ok', shown: exp, cands: candLabels };
    }
    if ((dC <= CLOSED_AMB_DIST && margin <= CLOSED_AMB_MARGIN) || openAgree) {
      return { grade: 'good', shown: oLabel || exp, cands: candLabels };
    }
    return { grade: 'ng', shown: oLabel || exp, cands: candLabels };
  }

  function grade() {
    if (isEnglish()) { gradeEnglish(); return; }
    var q = current();
    var wholeAnswer = !!banks[bankId].wholeAnswer;
    var results = [];
    for (var i = 0; i < cellTotal; i++) {
      var expected = i < q.a.length ? q.a[i] : '';
      var strokes = KanjiCanvas['recordedPattern_' + cellId(i)] || [];
      if (!expected) {
        results.push({ grade: strokes.length ? 'ng' : 'blank', shown: '', answer: '', cands: [] });
      } else if (!strokes.length) {
        results.push({ grade: 'ng', shown: '未記入', answer: expected, cands: [] });
      } else {
        results.push(closedSetDecision(i, expected));
      }
    }
    showResults(results, wholeAnswer);
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

  // 作問ツールの編集データを使用中なら案内を出す
  var note = document.getElementById('data-note');
  if (note && QuizStore.hasSaved()) {
    note.hidden = false;
    note.textContent = 'この端末の作問ツールで編集した問題を使用しています（配布には questions.js の書き出しが必要です）。';
  }
})();