# Train a compact CNN on the vector ref-patterns (katakana + hiragana + kanji)
# with handwriting-style augmentation. Exports ONNX (opset 17) + labels.json.
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data_pipeline import load_refs, normalize_coords, rasterize, augment

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUTDIR, exist_ok=True)
CKPT = os.path.join(OUTDIR, 'ckpt.pt')
RESUME = os.environ.get('RESUME', '0') == '1'

# 実手書きの学習データ（アプリの「学習用に保存→ダウンロード」で得た JSON）。
# 複数指定可（セミコロン区切り）。ディレクトリ指定なら中の *.json を全部読む。
REALDATA = os.environ.get('REALDATA', '')
REAL_REPEAT = int(os.environ.get('REAL_REPEAT', 5))   # 実データの訓練での重み（反復数）
REAL_VAL_PER_CHAR = int(os.environ.get('REAL_VAL_PER_CHAR', 2))

SIZE = 64
SAMPLES_PER_CLASS = int(os.environ.get('SPC', 40))          # per class per epoch
VAL_PER_CLASS = int(os.environ.get('VPC', 5))
EPOCHS = int(os.environ.get('EPOCHS', 14))
BATCH = int(os.environ.get('BATCH', 256))
LR = float(os.environ.get('LR', 1.5e-3))
WEIGHT_DECAY = 5e-4
WORKERS = int(os.environ.get('WORKERS', 6))
SEED = 1234

torch.manual_seed(SEED)
np.random.seed(SEED)


class Net(nn.Module):
    def __init__(self, n_classes):
        super().__init__()
        def block(cin, cout):
            return nn.Sequential(
                nn.Conv2d(cin, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
                nn.Conv2d(cout, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
                nn.MaxPool2d(2))
        self.features = nn.Sequential(
            block(1, 32),
            block(32, 64),
            block(64, 128),
            block(128, 256),
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(256 * 4 * 4, 1024), nn.BatchNorm1d(1024), nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(1024, n_classes),
        )

    def forward(self, x):
        return self.head(self.features(x))


class CharDataset(torch.utils.data.Dataset):
    def __init__(self, norm_by_char, labels, per_class, rng_seed):
        self.norm_by_char = norm_by_char
        self.labels = labels
        self.items = [(c, b) for c in range(len(labels)) for b in range(per_class)]
        self.rng = np.random.default_rng(rng_seed)

    def __len__(self):
        return len(self.items)

    def __getitem__(self, idx):
        c, _b = self.items[idx]
        bases = self.norm_by_char[self.labels[c]]
        coords = normalize_coords(bases[self.rng.integers(len(bases))])
        coords, width = augment(coords, self.rng)
        img = rasterize(coords, width)
        x = img.astype(np.float32) / 255.0
        return torch.from_numpy(x[None, :, :]), c


def build_val(norm_by_char, labels, per_class):
    rng = np.random.default_rng(999)
    X, y = [], []
    for c, ch in enumerate(labels):
        bases = norm_by_char[ch]
        for _ in range(per_class):
            coords = normalize_coords(bases[rng.integers(len(bases))])
            coords, width = augment(coords, rng)
            X.append(rasterize(coords, width))
            y.append(c)
    X = np.asarray(X, np.uint8)
    y = np.asarray(y, np.int64)
    return X, y


def build_clean(norm_by_char, labels):
    X = [rasterize(normalize_coords(norm_by_char[ch][0]), 3) for ch in labels]
    return np.asarray(X, np.uint8), np.arange(len(labels), dtype=np.int64)


def load_real_data(paths, labels):
    """実手書きJSON を取り込み、訓練用(by_charへ足す分)と評価用に分ける。"""
    import random
    rng = random.Random(123)
    per_char = {}
    train_by_char = {}
    val_samples = []
    unknown = 0
    files = []
    for p in paths:
        p = p.strip()
        if not p:
            continue
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p)) if f.endswith('.json')]
        else:
            files.append(p)
    for fp in files:
        if not os.path.exists(fp):
            print(f'  !! REALDATA not found: {fp}', flush=True)
            continue
        recs = json.load(open(fp, encoding='utf-8-sig'))
        for rec in recs:
            ch = rec.get('char')
            st = rec.get('strokes')
            if not ch or not st or ch not in labels:
                unknown += 1
                continue
            per_char.setdefault(ch, []).append(st)
        print(f'  loaded {len(recs)} records from {fp}', flush=True)
    for ch, samples in per_char.items():
        rng.shuffle(samples)
        keep = max(1, len(samples) - REAL_VAL_PER_CHAR)
        for s in samples[:keep]:
            train_by_char.setdefault(ch, []).extend([s] * REAL_REPEAT)
        for s in samples[keep:]:
            val_samples.append((ch, s))
    return train_by_char, val_samples, unknown


def build_real_val(norm_by_char, labels, val_samples):
    if not val_samples:
        return None, None
    X, y = [], []
    for ch, st in val_samples:
        X.append(rasterize(normalize_coords(st), 3))
        y.append(labels.index(ch))
    return np.asarray(X, np.uint8), np.asarray(y, np.int64)


def evaluate(model, X, y, batch=512):
    model.eval()
    top1 = top5 = 0
    with torch.no_grad():
        for i in range(0, len(X), batch):
            xb = torch.from_numpy(X[i:i + batch].astype(np.float32) / 255.0).unsqueeze(1)
            logits = model(xb)
            pred = logits.topk(5, 1).indices.numpy()
            for r, label in zip(pred, y[i:i + batch]):
                if r[0] == label:
                    top1 += 1
                if label in r:
                    top5 += 1
    n = len(X)
    return top1 / n, top5 / n


def export_onnx(model, labels):
    """Best-effort ONNX export; never fatal to the training run."""
    try:
        model.eval()
        dummy = torch.zeros(1, 1, SIZE, SIZE)
        out = os.path.join(OUTDIR, 'kanji_cnn.onnx')
        torch.onnx.export(
            model, dummy, out,
            input_names=['input'], output_names=['logits'],
            opset_version=18, dynamic_axes=None)
        # inline external weight data so the web app ships a single file
        import onnx as _onnx
        m = _onnx.load(out)
        data_file = out + '.data'
        if os.path.exists(data_file):
            os.remove(data_file)
        _onnx.save(m, out, save_as_external_data=False)
        torch.save(model.state_dict(), os.path.join(OUTDIR, 'kanji_cnn.pt'))
        with open(os.path.join(OUTDIR, 'labels.json'), 'w', encoding='utf-8') as f:
            json.dump(labels, f, ensure_ascii=False)
        print('  -> exported kanji_cnn.onnx', flush=True)
        return True
    except Exception as e:
        print('  !! ONNX export failed:', repr(e), flush=True)
        return False


def main():
    labels, by_char = load_refs()
    n_classes = len(labels)
    norm_by_char = {ch: [normalize_coords(s) for s in by_char[ch]] for ch in labels}
    classes = list(range(n_classes))
    print(f'classes={n_classes} samples/class={SAMPLES_PER_CLASS} '
          f'epoch={EPOCHS} batch={BATCH}')

    # 実手書きデータがあれば合成データに混ぜて再学習する
    real_val_x = real_val_y = None
    if REALDATA:
        real_train, real_val, unknown = load_real_data(REALDATA.split(';'), labels)
        for ch, samples in real_train.items():
            by_char.setdefault(ch, []).extend(samples)
        norm_by_char = {ch: [normalize_coords(s) for s in by_char[ch]] for ch in labels}
        real_val_x, real_val_y = build_real_val(norm_by_char, labels, real_val)
        print(f'real: train chars={len(real_train)} val={len(real_val)} '
              f'unknown(not in model)={unknown}', flush=True)

    ds = CharDataset(norm_by_char, labels, SAMPLES_PER_CLASS, SEED)
    loader = torch.utils.data.DataLoader(
        ds, batch_size=BATCH, shuffle=True, num_workers=WORKERS,
        persistent_workers=True, prefetch_factor=4, pin_memory=True)
    X_val, y_val = build_val(norm_by_char, labels, VAL_PER_CLASS)
    X_clean, y_clean = build_clean(norm_by_char, labels)
    print(f'val={len(X_val)} clean={len(X_clean)}')

    model = Net(n_classes)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)
    lossf = nn.CrossEntropyLoss()

    best = 0.0
    best_state = None
    iters_per_epoch = len(loader)
    with open(os.path.join(OUTDIR, 'labels.json'), 'w', encoding='utf-8') as f:
        json.dump(labels, f, ensure_ascii=False)
    start_ep = 1
    if RESUME and os.path.exists(CKPT):
        ck = torch.load(CKPT, map_location='cpu')
        model.load_state_dict(ck['state'])
        opt.load_state_dict(ck['opt'])
        if 'sched' in ck:
            sched.load_state_dict(ck['sched'])
        else:
            sched.last_epoch = ck['epoch']
        best = ck['best']
        start_ep = ck['epoch'] + 1
        print(f'resumed from epoch {ck["epoch"]} (best={best * 100:.1f}%)', flush=True)
    for ep in range(start_ep, EPOCHS + 1):
        model.train()
        t0 = time.time()
        tot = 0.0
        for it, (xb, yb) in enumerate(loader):
            opt.zero_grad()
            loss = lossf(model(xb), yb)
            loss.backward()
            opt.step()
            tot += loss.item()
            if (it + 1) % 100 == 0:
                print(f'  ep{ep} iter {it + 1}/{iters_per_epoch} loss {tot / (it + 1):.3f} '
                      f'({time.time() - t0:.0f}s)', flush=True)
        sched.step()
        va1, va5 = evaluate(model, X_val, y_val)
        cl1, cl5 = evaluate(model, X_clean, y_clean)
        line = (f'ep{ep} train_loss={tot / iters_per_epoch:.3f} '
                f'val_top1={va1 * 100:.1f}% top5={va5 * 100:.1f}% '
                f'clean_top1={cl1 * 100:.1f}% top5={cl5 * 100:.1f}% '
                f'({time.time() - t0:.0f}s)')
        if real_val_x is not None:
            r1, r5 = evaluate(model, real_val_x, real_val_y)
            line += f' REAL_top1={r1 * 100:.1f}% top5={r5 * 100:.1f}%'
        print(line, flush=True)
        # checkpoint each epoch so an interrupted run still yields a model
        torch.save({'epoch': ep, 'state': model.state_dict(),
                    'opt': opt.state_dict(), 'sched': sched.state_dict(),
                    'best': best},
                   os.path.join(OUTDIR, 'ckpt.pt'))
        if va1 > best:
            best = va1
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            export_onnx(model, labels)
            print(f'  -> saved best ONNX (val_top1={best * 100:.1f}%)', flush=True)

    if best_state is not None:
        model.load_state_dict(best_state)
    print(f'BEST val_top1={best * 100:.1f}%')
    print('saved labels.json + checkpoint to', OUTDIR)


if __name__ == '__main__':
    main()
