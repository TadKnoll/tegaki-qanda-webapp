# CNN 手書き認識モデル（学習パイプライン）

kanjicanvas のテンプレート照合を、ブラウザ内 CNN（onnxruntime-web）に置き換えるための学習コード。

## 現状（2026-08-09）

- 2357 クラス（カタカナ 73・ひらがな 71・漢字 2213）を学習
- 参照パターン（`vendor/ref-patterns.js`）のベクトルストロークを 64×64 画像にラスタライズし、
  手書き風に拡張（回転・シアー・点ジッタ・筆圧幅・ストローク統合/順序入れ替え）
- 進捗: エポック 2 まで完了（`out/ckpt.pt`、val_top1=99.6% / top5=100.0%）
- ONNX エクスポート: opset 18・単一ファイル（重みインライン化済み）`out/kanji_cnn.onnx`（約31MB、fp32）

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

## 残作業（ブラウザ統合）

1. 学習完了 → `out/kanji_cnn.onnx` を `vendor/onnx/` へコピー（任意で int8 量子化で 10MB 弱に）
2. `vendor/onnx/onnxruntime-web` の wasm ファイルを自己ホスト配置（オフライン対応）
3. `js/cnn.js` 実装: 前処理（`training/data_pipeline.py` の normalize_coords+rasterize を JS に移植）→ 推論 → top-k
4. `js/app.js` の採点を CNN 確率ベースに切替（async 対応）
5. 精度検証・コミット

## 注意

- 前処理は学習時と推論時で完全一致させること（`data_pipeline.py` の `normalize_coords` / `rasterize` / `STEP=0.5`）
- モデルは合成データ（フォント由来ベクトル）学習のため、実手書きとの乖離は
  現地での自己採点（△）でカバー。実データを集められれば追加学習で改善可能
