(function () {
  'use strict';

  var working = QuizStore.load();
  var currentBank = 'history';

  var tabsEl = document.getElementById('tabs');
  var qlistEl = document.getElementById('qlist');
  var settingsEl = document.getElementById('settings');
  var settingsPanelEl = document.getElementById('settings-panel');
  var datastatusEl = document.getElementById('datastatus');
  var bulkEl = document.getElementById('bulk');
  var statusMsg = '';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatusMsg(msg) {
    statusMsg = msg;
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    Object.keys(QuizStore.defaultBanks()).forEach(function (bid) {
      var b = working[bid];
      var n = (b && b.questions) ? b.questions.length : 0;
      var btn = document.createElement('button');
      btn.className = 'tab' + (bid === currentBank ? ' active' : '');
      btn.textContent = (b ? b.label : bid) + ' (' + n + ')';
      btn.addEventListener('click', function () {
        currentBank = bid;
        render();
      });
      tabsEl.appendChild(btn);
    });
  }

  function renderSettings() {
    if (currentBank === 'english') {
      settingsPanelEl.style.display = 'none';
      settingsEl.innerHTML = '';
      return;
    }
    settingsPanelEl.style.display = 'block';
    var b = working[currentBank];
    var cells = (b && b.maxCells) || 0;
    var whole = !!(b && b.wholeAnswer);
    settingsEl.innerHTML =
      '<label>マス数 <input type="number" id="set-cells" min="1" max="24" value="' + cells + '"></label>'
      + '<label><input type="checkbox" id="set-whole"' + (whole ? ' checked' : '') + '> 全体採点（全マス正解で正解）</label>';
  }

  function renderList() {
    var qs = (working[currentBank] && working[currentBank].questions) || [];
    var html = '<div class="qhead"><span></span><span>#</span><span>出題文</span><span>正解</span><span></span></div>';
    qs.forEach(function (it, i) {
      html += '<div class="qrow" data-i="' + i + '">'
        + '<label class="ck"><input type="checkbox" class="qck"></label>'
        + '<span class="idx">' + (i + 1) + '</span>'
        + '<input type="text" class="q-text" value="' + esc(it.q) + '">'
        + '<input type="text" class="a-text" value="' + esc(it.a) + '">'
        + '<button type="button" class="btn del-one">削除</button>'
        + '</div>';
    });
    if (qs.length === 0) html += '<p class="help">問題がありません。「一括追加」で追加するか、「保存」欄で追加できます。</p>';
    qlistEl.innerHTML = html;
  }

  function renderStatus() {
    var saved = QuizStore.hasSaved();
    var s = saved
      ? 'この端末の編集データを使用しています。生徒への配布には「questions.js を書き出し」が必要です。'
      : '編集データはありません（初期問題を使用しています）。';
    if (statusMsg) { s = statusMsg + ' ｜ ' + s; }
    datastatusEl.textContent = s;
  }

  function render() {
    renderTabs();
    renderSettings();
    renderList();
    renderStatus();
  }

  // ---- 保存（テキスト欄の変更を反映） ----
  function save() {
    var rows = qlistEl.querySelectorAll('.qrow');
    var qs = [];
    rows.forEach(function (row) {
      var q = row.querySelector('.q-text').value.trim();
      var a = row.querySelector('.a-text').value.trim();
      if (!a) return; // 正解が空の行は保存しない
      qs.push({ q: q, a: a });
    });
    working[currentBank].questions = qs;
    var cellsEl = document.getElementById('set-cells');
    if (cellsEl) working[currentBank].maxCells = parseInt(cellsEl.value, 10) || 0;
    var wholeEl = document.getElementById('set-whole');
    if (wholeEl) working[currentBank].wholeAnswer = wholeEl.checked;
    QuizStore.save(working);
    setStatusMsg('保存しました');
    render();
  }

  // ---- 削除 ----
  function delChecked() {
    var checks = qlistEl.querySelectorAll('.qck:checked');
    if (checks.length === 0) { setStatusMsg('削除する問題を選択してください'); render(); return; }
    var idxs = [];
    checks.forEach(function (c) { idxs.push(parseInt(c.closest('.qrow').dataset.i, 10)); });
    idxs.sort(function (a, b) { return b - a; });
    idxs.forEach(function (i) { working[currentBank].questions.splice(i, 1); });
    QuizStore.save(working);
    setStatusMsg(idxs.length + '件を削除しました');
    render();
  }

  // ---- 一括追加 ----
  function parseBulk(text) {
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var parts = line.split('|');
      var a = (parts[1] || '').trim();
      if (!a) return;
      out.push({ q: (parts[0] || '').trim(), a: a });
    });
    return out;
  }

  function bulkAdd() {
    var added = parseBulk(bulkEl.value);
    if (added.length === 0) {
      setStatusMsg('追加できる行がありません（「出題文 | 正解」の形式で書いてください）');
      render();
      return;
    }
    working[currentBank].questions = working[currentBank].questions.concat(added);
    QuizStore.save(working);
    bulkEl.value = '';
    setStatusMsg(added.length + '件を追加しました');
    render();
  }

  // ---- 書き出し ----
  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function exportJs() {
    download('questions.js', QuizStore.buildJs(working), 'application/javascript');
    setStatusMsg('questions.js を書き出しました（js/questions.js と置き換えて配置してください）');
    render();
  }

  function exportJson() {
    download('questions-backup.json', QuizStore.toJson(working), 'application/json');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        working = QuizStore.fromJson(reader.result);
        QuizStore.save(working);
        if (working[currentBank] === undefined) currentBank = 'history';
        setStatusMsg('読み込みました');
      } catch (e) {
        setStatusMsg('読み込みに失敗しました：' + e.message);
      }
      render();
    };
    reader.readAsText(file);
  }

  function reset() {
    if (!confirm('この端末の編集データを削除し、初期問題に戻しますか？')) return;
    QuizStore.clear();
    working = QuizStore.defaultBanks();
    setStatusMsg('初期問題に戻しました');
    render();
  }

  // ---- イベント登録 ----
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('del-checked').addEventListener('click', delChecked);
  document.getElementById('check-all').addEventListener('click', function () {
    var c = qlistEl.querySelectorAll('.qck');
    c.forEach(function (x) { x.checked = true; });
  });
  document.getElementById('bulk-add').addEventListener('click', bulkAdd);
  document.getElementById('export-js').addEventListener('click', exportJs);
  document.getElementById('export-json').addEventListener('click', exportJson);
  document.getElementById('reset').addEventListener('click', reset);
  document.getElementById('import-json').addEventListener('change', function (ev) {
    if (ev.target.files && ev.target.files[0]) importJson(ev.target.files[0]);
  });

  // 動的な問題行のイベントは委譲で処理
  qlistEl.addEventListener('click', function (ev) {
    var del = ev.target.closest ? ev.target.closest('.del-one') : null;
    if (del) {
      var i = parseInt(del.closest('.qrow').dataset.i, 10);
      working[currentBank].questions.splice(i, 1);
      QuizStore.save(working);
      setStatusMsg('1件を削除しました');
      render();
    }
  });

  render();
})();
