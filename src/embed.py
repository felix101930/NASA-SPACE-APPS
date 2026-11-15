"""Model 10 input: DINOv2-small embeddings of terrain rendered at sun 3 deg (4 azimuths, mean embedding).

Run: python src/embed.py <scratch_dir>   -> <scratch_dir>/embeddings.npz (ids, emb384, emb192)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).parent))
from moon import region_data
from terrain import MARGIN, horizon_tan, render

ROOT = Path(__file__).resolve().parents[1]
AZ4 = (0.0, 90.0, 180.0, 270.0)


def images(zpad):
    """Rendered crops (3.84 km and 1.92 km) for 4 azimuths, exposure-normalized to 0..1."""
    m, out384, out192 = MARGIN, [], []
    for az in AZ4:
        img, lit = render(zpad, az, 3.0, horizon_tan(zpad, az))
        a = img[m:m + 128, m:m + 128]
        v = a[a > 0]
        a = np.clip(a / (np.percentile(v, 99) + 1e-9), 0, 1) if v.size else a
        out384.append(a)
        out192.append(a[32:96, 32:96])
    return out384, out192


def main(scratch):
    from transformers import AutoModel
    torch.set_num_threads(16)
    model = AutoModel.from_pretrained("facebook/dinov2-small").eval()
    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)

    def emb(batch):
        x = torch.tensor(np.stack(batch), dtype=torch.float32)[:, None].repeat(1, 3, 1, 1)
        x = torch.nn.functional.interpolate(x, size=224, mode="bilinear", align_corners=False)
        with torch.no_grad():
            e = model(pixel_values=(x - mean) / std).last_hidden_state[:, 0]
        return e.numpy()

    ids, zps = [], []
    mw = pd.read_csv(ROOT / "results" / "moon_windows.csv")
    for reg, g in mw.groupby("region"):
        d = region_data(reg)
        pad = 64 + MARGIN
        for i, row in g.iterrows():
            r = int(np.argmin(np.abs(d["gy"] - row.y))); c = int(np.argmin(np.abs(d["gx"] - row.x)))
            ids.append(f"moon_{i}"); zps.append(("z", d["z30"][r - pad:r + pad, c - pad:c + pad]))
    ew = pd.read_csv(ROOT / "results" / "earth_windows.csv")
    for wid in ew["id"]:
        ids.append(wid); zps.append(("f", Path(scratch) / "earth_z" / f"{wid}.npy"))
    E384, E192 = [], []
    for k in range(0, len(zps), 16):
        b384, b192 = [], []
        for kind, v in zps[k:k + 16]:
            a, b = images(np.load(v) if kind == "f" else v)
            b384 += a; b192 += b
        e1, e2 = emb(b384).reshape(-1, 4, 384).mean(1), emb(b192).reshape(-1, 4, 384).mean(1)
        E384.append(e1 / np.linalg.norm(e1, axis=1, keepdims=True))
        E192.append(e2 / np.linalg.norm(e2, axis=1, keepdims=True))
        if k % 800 == 0:
            print(k, len(zps), flush=True)
    np.savez(Path(scratch) / "embeddings.npz", ids=np.array(ids), emb384=np.concatenate(E384), emb192=np.concatenate(E192))


if __name__ == "__main__":
    main(sys.argv[1])
