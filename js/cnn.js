/* CNN 手書き認識（onnxruntime-web）
 * 前処理は training/data_pipeline.py の normalize_coords + rasterize と完全一致させること
 * （SIZE=64, PAD=4, STEP=0.5, width=3）。入力: 生ストローク [[[x,y],...], ...]
 */
var CNN = (function () {
  'use strict';

  var SIZE = 64;
  var PAD = 4;
  var STEP = 0.5;
  var WIDTH = 3;

  var session = null;
  var labels = window.CNN_LABELS || [];
  var labelIndex = {};
  for (var li = 0; li < labels.length; li++) labelIndex[labels[li]] = li;

  var available = !!window.ort;
  if (available) {
    // ort は wasmPaths + ファイル名 をスクリプト位置基準で解決するため、絶対パスにする
    var base = location.pathname;
    ort.env.wasm.wasmPaths = base.substring(0, base.lastIndexOf('/') + 1) + 'vendor/onnx/';
  }

  function normalizeCoords(strokes) {
    var pts = [];
    for (var s = 0; s < strokes.length; s++) {
      for (var p = 0; p < strokes[s].length; p++) pts.push(strokes[s][p]);
    }
    if (!pts.length) return [];
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < x0) x0 = pts[i][0];
      if (pts[i][0] > x1) x1 = pts[i][0];
      if (pts[i][1] < y0) y0 = pts[i][1];
      if (pts[i][1] > y1) y1 = pts[i][1];
    }
    var bw = Math.max(x1 - x0, 1e-6);
    var bh = Math.max(y1 - y0, 1e-6);
    var sc = (SIZE - 2 * PAD) / Math.max(bw, bh);
    var cx = (SIZE - bw * sc) / 2;
    var cy = (SIZE - bh * sc) / 2;
    var out = [];
    for (var j = 0; j < strokes.length; j++) {
      var st = strokes[j];
      var nst = [];
      for (var k = 0; k < st.length; k++) {
        nst.push([st[k][0] * sc - x0 * sc + cx, st[k][1] * sc - y0 * sc + cy]);
      }
      out.push(nst);
    }
    return out;
  }

  function samplePoints(coords) {
    var pts = [];
    for (var s = 0; s < coords.length; s++) {
      var st = coords[s];
      for (var i = 0; i < st.length - 1; i++) {
        var x0 = st[i][0], y0 = st[i][1], x1 = st[i + 1][0], y1 = st[i + 1][1];
        var dx = x1 - x0, dy = y1 - y0;
        var d = Math.sqrt(dx * dx + dy * dy);
        var n = Math.max(1, Math.ceil(d / STEP));
        for (var k = 0; k < n; k++) {
          var t = k / n;
          pts.push([x0 + dx * t, y0 + dy * t]);
        }
      }
      if (st.length) pts.push([st[st.length - 1][0], st[st.length - 1][1]]);
    }
    return pts;
  }

  function rasterize(coords) {
    var img = new Float32Array(SIZE * SIZE);
    var pts = samplePoints(coords);
    if (!pts.length) return img;
    var r = WIDTH / 2;
    var R = Math.ceil(r);
    var mask = [];
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy <= r * r) mask.push([dx, dy]);
      }
    }
    for (var i = 0; i < pts.length; i++) {
      var xi = Math.round(pts[i][0]);
      var yi = Math.round(pts[i][1]);
      for (var m = 0; m < mask.length; m++) {
        var px = xi + mask[m][0];
        var py = yi + mask[m][1];
        if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
        img[py * SIZE + px] = 1.0;
      }
    }
    return img;
  }

  function preprocess(strokes) {
    var coords = normalizeCoords(strokes);
    var img = rasterize(coords);
    return new ort.Tensor('float32', img, [1, 1, SIZE, SIZE]);
  }

  function init() {
    if (!available) return Promise.reject(new Error('onnxruntime-web が読み込めていません'));
    if (session) return Promise.resolve(session);
    return ort.InferenceSession.create('vendor/onnx/kanji_cnn.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    }).then(function (s) { session = s; return s; });
  }

  function softmax(logits) {
    var mx = -Infinity;
    for (var i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
    var e = new Float32Array(logits.length);
    var sum = 0;
    for (var j = 0; j < logits.length; j++) { e[j] = Math.exp(logits[j] - mx); sum += e[j]; }
    for (var k = 0; k < e.length; k++) e[k] /= sum;
    return e;
  }

  function topk(probs, k) {
    var idx = [];
    for (var i = 0; i < probs.length; i++) idx.push(i);
    idx.sort(function (a, b) { return probs[b] - probs[a]; });
    var res = [];
    for (var j = 0; j < k && j < idx.length; j++) {
      res.push({ label: labels[idx[j]] || '', index: idx[j], prob: probs[idx[j]] });
    }
    return res;
  }

  function recognize(strokes, k) {
    return init().then(function (s) {
      var feeds = { input: preprocess(strokes) };
      return s.run(feeds).then(function (out) {
        var logits = out.logits.data;
        var probs = softmax(logits);
        return { top: topk(probs, k || 5), probs: probs };
      });
    });
  }

  function indexOf(label) {
    return labelIndex[label] !== undefined ? labelIndex[label] : -1;
  }

  return {
    available: available,
    init: init,
    recognize: recognize,
    preprocess: preprocess,
    indexOf: indexOf,
    labels: labels,
    SIZE: SIZE
  };
})();
