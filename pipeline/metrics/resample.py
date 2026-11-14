"""Resampling onto the common comparison grid.

Downsampling (dst_res >= src_res) is exact area averaging: each output cell is the
overlap-area-weighted mean of the input cells it covers (separable, so it is two small matrix
products). NaNs are excluded from the mean; an output cell is NaN when less than
``min_valid_frac`` of its area has data. Upsampling uses bilinear interpolation.

Alignment: the output's top-left corner coincides with the input's top-left corner, and the
output has ``floor(n * src_res / dst_res)`` pixels per axis (a trailing partial cell is dropped).
So the output georeference is the input origin with pixel size ``dst_res``.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import map_coordinates


def _overlap_weights(n_src: int, src_res: float, n_dst: int, dst_res: float) -> np.ndarray:
    """(n_dst, n_src) overlap lengths between output and input cells along one axis."""
    s0 = np.arange(n_src) * src_res
    d0 = np.arange(n_dst) * dst_res
    lo = np.maximum(d0[:, None], s0[None, :])
    hi = np.minimum(d0[:, None] + dst_res, s0[None, :] + src_res)
    return np.clip(hi - lo, 0.0, None)


def to_grid(dem: np.ndarray, src_res: float, dst_res: float = 30.0,
            min_valid_frac: float = 0.5) -> np.ndarray:
    """Resample ``dem`` (pixel size ``src_res`` m) to ``dst_res`` m. Returns float64."""
    z = np.asarray(dem, dtype=np.float64)
    n0 = int(math.floor(z.shape[0] * src_res / dst_res + 1e-9))
    n1 = int(math.floor(z.shape[1] * src_res / dst_res + 1e-9))
    if n0 < 1 or n1 < 1:
        raise ValueError("output grid would be empty")
    if math.isclose(src_res, dst_res):
        return z[:n0, :n1].copy()
    if dst_res > src_res:
        wr = _overlap_weights(z.shape[0], src_res, n0, dst_res)
        wc = _overlap_weights(z.shape[1], src_res, n1, dst_res)
        ok = np.isfinite(z)
        num = wr @ np.where(ok, z, 0.0) @ wc.T
        den = wr @ ok.astype(np.float64) @ wc.T
        full = wr.sum(1)[:, None] * wc.sum(1)[None, :]
        with np.errstate(invalid="ignore", divide="ignore"):
            out = num / den
        out[den < min_valid_frac * full] = np.nan
        return out
    rr = (np.arange(n0) + 0.5) * dst_res / src_res - 0.5
    cc = (np.arange(n1) + 0.5) * dst_res / src_res - 0.5
    gr, gc = np.meshgrid(rr, cc, indexing="ij")
    return map_coordinates(z, [gr, gc], order=1, mode="nearest", prefilter=False)
