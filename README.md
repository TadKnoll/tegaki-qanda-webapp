# 手書き 一問一答 WebApp

Chromebook / iPad のブラウザで動作する、手書き入力による一問一答チェック Web アプリ（作問ツール付き）。

## 概要

- 出題ページ（`index.html`）と作問ツール（`admin.html`）の 2 ページ構成の完全静的サイト
- 漢字・歴史：1 文字 = 1 マスの手書き（ブラウザ内 CNN 推論: onnxruntime-web）
- 英語：1 語 = 1 枠の画像認識（Tesseract.js OCR、CDN 読み込み・要インターネット）
- 問題データは端末の `localStorage` に保存（`quiz_banks_v1`）。配布時は `questions.js` を書き出して差し替える方式
- **注意**: 漢字・歴史の採点は onnxruntime-web が `fetch()` でモデルを読むため `file://` では動作しません。
  `python -m http.server` 等の HTTP サーバー、または GitHub Pages 経由で開いてください

## ディレクトリ構成

```
手書き一問一答WebApp/
├── index.html          # 出題ページ
├── admin.html          # 作問ツール
├── css/
│   ├── style.css       # 出題ページ用スタイル
│   └── admin.css       # 作問ツール用スタイル
├── js/
│   ├── questions.js          # 問題バンク定義（配布データ）
│   ├── questions-store.js    # localStorage 保存・読み込み・書き出し
│   ├── cnn.js                # CNN 推論（前処理移植 + onnxruntime-web）
│   ├── app.js                # 出題・採点ロジック
│   └── admin.js              # 作問ツールロジック
├── training/            # 学習パイプライン（詳細は training/README.md）
└── vendor/
    ├── kanji-canvas.min.js   # 手書きキャンバス入力（asdfjkl/kanjicanvas, MIT）
    ├── ref-patterns.js       # 参照パターンデータ（6.9MB・増強版）
    └── onnx/                 # onnxruntime-web 1.19.2 自己ホスト + モデル
        ├── ort.min.js
        ├── ort-wasm-simd-threaded.wasm / .mjs
        ├── ort-wasm-simd-threaded.jsep.wasm / .mjs
        ├── kanji_cnn.onnx    # 学習済み CNN（31MB, 2357 クラス）
        └── labels.js         # クラス順の文字リスト
```

## 出題ページの仕様

- タブで「歴史 / 漢字 / 英語」を切り替え
- 歴史・漢字：正解の文字数分 + 余裕分のマスを表示（`maxCells` と正解文字数の大きい方）
- マスは左から順に 1 字ずつ手書き。余ったマスは空のまま OK
- 「この 1 字を消す」「全部消す」「採点する」ボタン
- 採点方式
  - 歴史：**全体採点**（`wholeAnswer: true`）— 全マスが ○ か △ なら「◯ 正解！」
  - 漢字：文字ごとの ○△×
    - ○ = 正解（CNN が正解を top1 で判定 & 確率 0.50 以上）
    - △ = 自動判定に自信がない文字（「候補」を表示し、生徒が ○/× を選んで自己採点）
    - × = 不正解
  - 英語：OCR 結果を英字正規化して照合（認識語彙を解答で使う文字に限定する `tessedit_char_whitelist` を使用）
- ナビゲーションで前後の問題へ移動（循環）

### CNN 採点（正解照合モード）

- 歴史・漢字はマスの**正解文字が既知**であることを利用し、CNN の softmax 確率で ○/△/× を判定する（`js/app.js`・`js/cnn.js`）
- 判定ルール
  - ○: top1 == 正解 かつ 確率 >= 0.50
  - △: 正解が top5 候補内、または正解確率 >= 0.25（自信が無い → 自己判定）
  - ×: 上記以外。モデルに含まれない文字は自動判定せず △ に回す
- モデルは `training/` で合成データ（フォント由来ベクトル + 手書き風拡張）から学習した
  2357 クラス CNN（val_top1=99.97%）。詳細は `training/README.md` 参照

## 作問ツールの仕様

- タブごとに問題一覧を編集（出題文・正解のテキスト欄）
- マス数 / 全体採点の設定（英語は設定なし）
- チェックボックスで複数削除、一括追加（1 行に「出題文 | 正解」形式）
- 書き出し・読み込み
  - `questions.js` を書き出し（配布用）→ `js/questions.js` と置き換えて配置
  - バックアップ JSON 書き出し / JSON 読み込み
  - 初期問題に戻す
- 「保存」でテキスト欄の変更を localStorage へ反映（削除・追加は即反映）

## 開発環境と GitHub 連携

- リポジトリ: https://github.com/TadKnoll/tegaki-qanda-webapp （Public、`main` ブランチ）
- ホスティング: GitHub Pages（`main` ブランチ / ルート）→ push で自動デプロイ
- 公開 URL:
  - 出題ページ: https://tadknoll.github.io/tegaki-qanda-webapp/
  - 作問ツール: https://tadknoll.github.io/tegaki-qanda-webapp/admin.html
- GitHub CLI（gh）を winget で導入済み、git 設定済み
  - user.name: TadKnoll / user.email: 286025236+TadKnoll@users.noreply.github.com
- 注意: リポジトリは Public のため、問題データが外部に公開される

### 開発フロー

```
編集 → git add -A → git commit -m "..." → git push origin main
```

`main` への push で GitHub Pages が自動で更新される（反映まで 1〜2 分）。

## カタカナ認識精度の改善（実施済み）

### 背景

- 参照パターンが各文字 1 サンプル（フォント由来の理想字形）のみで、生徒の手書きのゆらぎ（太さ・傾き・ストローク数・順序）に弱かった
- 特に ソ/ン/シ/ツ、ク/ソ、エ/ニ、リ/ノ など似た形の字の混同が多かった

### 対応

- 既存の各カタカナ 73 字 × 4 サンプルの変形合成（位置ゆらぎ・比率変化・ストローク統合・順序入替）を追加生成し、`vendor/ref-patterns.js` を再生成（2357 → 2649 エントリ）
- 生成は決定論的（シード固定）で再現可能

### 精度検証（実際の認識エンジンを Node ヘッドレスで実行）

| 指標 | 変更前 | 変更後 |
|---|---|---|
| カタカナ 1 位一致 | 74.8% | 83.0% |
| カタカナ 上位 5 位内 | 88.9% | 94.0% |
| 歴史バンクのカタカナ 1 位 | — | 85.0% |
| 漢字（劣化なし） | 95.0% | 95.0% |

- 元ファイルのバックアップ: `C:\Users\koyama\AppData\Local\Temp\opencode\ref-patterns.orig.js`
- 増強スクリプト: `C:\Users\koyama\AppData\Local\Temp\opencode\augment_refs.py`

## 履歴

| コミット | 内容 |
|---|---|
| `9817966` | 初回コミット: 手書き一問一答 WebApp |
| `fe1b276` | カタカナ認識精度を向上: 参照パターンを各文字 4 サンプルに増強 |
| `2c9e42d` | 閉集合採点 + 自己採点（△）モード + 英語 whitelist を実装 |
| `5dd9e7d` | CNN 手書き認識の学習パイプラインを追加（チェックポイント・ONNX含む） |
| （未コミット） | 学習 14 エポック完了 + ブラウザ統合（onnxruntime-web 自己ホスト・`js/cnn.js`・採点を CNN に切替） |

## メモ・既知の点

- 作問ツールの編集データは端末ごとの `localStorage`。iPad で作問した内容はその iPad 専用で、配布時は「questions.js を書き出し」で共有
- 英語 OCR は Tesseract.js を CDN から読み込むため、オフラインでは動作しない
- 漢字・歴史の採点は onnxruntime-web が `fetch()` でモデル/ wasm を読み込むため、`file://` では動作しない
  （`python -m http.server` 等の HTTP サーバー、または GitHub Pages 経由で開く）
