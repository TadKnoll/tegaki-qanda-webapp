# CNN 手書き認識モデル（学習パイプライン）

kanjicanvas のテンプレート照合を、ブラウザ内 CNN（onnxruntime-web）に置き換えるための学習コード。

## 現状（2026-08-10）

- 2357 クラス（カタカナ 73・ひらがな 71・漢字 2213）を学習
- 参照パターン（`vendor/ref-patterns.js`）のベクトルストロークを 64×64 画像にラスタライズし、
  手書き風に拡張（回転・シアー・点ジッタ・筆圧幅・ストローク統合/順序入れ替え）
- **学習完了**: 14 エポック終了（`out/ckpt.pt`、BEST val_top1=99.97% / 最終 ep14 val_top1=99.9%・top5=100%）
- ONNX エクスポート: opset 18・単一ファイル（重みインライン化済み）`out/kanji_cnn.onnx`（約31MB、fp32）
- ブラウザ統合済み（下記「ブラウザ統合」参照）

## 必要環境（別端末で続ける場合）

- Python 3.14（3.10〜3.13 でも可）
- 依存: `pip install torch onnx onnxruntime numpy pillow onnxscript`
  - Windows/Linux で CPU 版 torch: `pip install torch --index-url https://download.pytorch.org/whl/cpu`
  - macOS: `pip install torch`（そのまま）

## 実行

リポジトリをクローンして `training/` で実行:

```
git clone https://github.com/TadKnoll/tegaki-qanda-webapp
cd tegaki-qanda-webapp/training
```

- 初回学習: `python train_cnn.py`
- **中断からの再開**（チェックポイント `out/ckpt.pt` があれば）:

Windows (PowerShell):
```
$env:EPOCHS='14'; $env:RESUME='1'; $env:PYTHONIOENCODING='utf-8'; python train_cnn.py
```

macOS / Linux:
```
EPOCHS=14 RESUME=1 PYTHONIOENCODING=utf-8 python train_cnn.py
```

環境変数（既定値）:
- `EPOCHS=14` 学習エポック数
- `SPC=40` クラスあたりの学習サンプル数/エポック
- `VPC=5` 固定検証サンプル数/クラス
- `BATCH=256` / `LR=1.5e-3` / `WORKERS=6`
- `REFPATH=` 参照パターンの場所（既定はリポジトリ内 `vendor/ref-patterns.js`）

学習は CPU で約 12 分/エポック（`SPC=40, WORKERS=6`）。10 エポックで十分収束
（val_top1≈99.9%）。各エポック終了時に `out/ckpt.pt` を保存し、val が更新した時は
`out/kanji_cnn.onnx` を書き出すので、途中で止めても再開可能。

## 出力物

- `out/kanji_cnn.onnx` — ブラウザ用モデル（入力 `input` [1,1,64,64] float32、出力 `logits` [1,2357]）
- `out/labels.json` — クラス順の文字リスト（argmax のインデックスで引く）
- `out/kanji_cnn.pt` — PyTorch チェックポイント
- `out/ckpt.pt` — 学習再開用チェックポイント（model/optimizer/scheduler/epoch）

## ブラウザ統合（実施済み 2026-08-10）

1. `out/kanji_cnn.onnx` を `vendor/onnx/kanji_cnn.onnx` へコピー
2. onnxruntime-web **1.19.2** を `vendor/onnx/` に自己ホスト
   - `ort.min.js` / `ort-wasm-simd-threaded.wasm` / `ort-wasm-simd-threaded.jsep.wasm` / `.mjs` グルー
   - スレッド版のみ同梱だが、SharedArrayBuffer 無しでも単一スレッドへ自動フォールバックするため
     特別な COOP/COEP ヘッダーは不要
3. `js/cnn.js` 実装: `data_pipeline.py` の `normalize_coords`+`rasterize`（STEP=0.5, width=3, SIZE=64, PAD=4）を
   JS に移植し、softmax → top-k を返す。`wasmPaths` は `location.pathname` 基準の絶対パスで設定
4. `js/app.js` の採点を CNN 確率ベースに切替（async 対応）
   - ○: top1==正解 かつ prob>=0.50、△: 正解が top5 内 または prob>=0.25、それ以外 ×
   - モデルに無い文字は自動判定せず △（自己判定）に回す
5. 精度検証: 参照パターン 30 文字の推論で全件 top1 一致（確率 0.92〜1.00）。
   アプリの採点フローを Chrome ヘッドレスで E2E 検証（正解→○、誤字→×）

### 注意

- onnxruntime-web は `fetch()` でモデル/ wasm を読み込むため、**`file://` では動作しない**。
  `python -m http.server` 等の HTTP サーバー、または GitHub Pages 経由で開くこと。
- 前処理は学習時と推論時で完全一致させること（`data_pipeline.py` の `normalize_coords` / `rasterize` / `STEP=0.5`）
- モデルは合成データ（フォント由来ベクトル）学習のため、実手書きとの乖離は
  現地での自己採点（△）でカバー。実データを集められれば追加学習で改善可能
