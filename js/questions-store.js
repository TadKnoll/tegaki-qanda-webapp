// 問題データの保存・読み込み・書き出し（作問ツールと出題ページで共有）
(function (global) {
  'use strict';

  var KEY = 'quiz_banks_v1';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultBanks() { return clone(global.BANKS); }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var b = JSON.parse(raw);
        if (b && typeof b === 'object' && b.history) {
          return b;
        }
      }
    } catch (e) { /* ignore */ }
    return defaultBanks();
  }

  function save(b) {
    try { localStorage.setItem(KEY, JSON.stringify(b)); return true; }
    catch (e) { return false; }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  function hasSaved() {
    return !!localStorage.getItem(KEY);
  }

  function toJson(b) { return JSON.stringify(b, null, 2); }

  function fromJson(text) {
    var b = JSON.parse(text);
    if (!b || typeof b !== 'object' || !b.history) {
      throw new Error('形式が正しくありません（歴史バンクが必要です）');
    }
    return b;
  }

  // 配布用 questions.js を生成
  function buildJs(b) {
    return '// 作問ツールで生成した問題データ\n'
      + '// （js/questions.js と置き換えてサーバーに配置すると、生徒に反映されます）\n'
      + 'var BANKS = ' + JSON.stringify(b, null, 2) + ';\n';
  }

  global.QuizStore = {
    load: load,
    save: save,
    clear: clear,
    hasSaved: hasSaved,
    toJson: toJson,
    fromJson: fromJson,
    buildJs: buildJs,
    defaultBanks: defaultBanks,
  };
})(window);
