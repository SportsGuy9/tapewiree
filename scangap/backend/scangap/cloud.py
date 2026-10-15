"""Streaming passes over a point cloud.

Pass 1: bounds, Z histogram, per-scan counts, viewer sample.
Floor detection on the Z histogram.
Pass 2: per-floor density grids of the 0.5–2.0 m slice.

Only histograms and a small sample are kept in memory, so file size is bounded
by disk, not RAM.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .readers import CloudHeader, open_cloud

Z_BIN = 0.02  # m


@dataclass
class Grid:
    origin: tuple[float, float]  # (x0, y0) of cell [0, 0] lower-left corner
    cell: float
    counts: np.ndarray  # (ny, nx) int64 point counts per cell in the slice
    slice_min: float  # absolute Z
    slice_max: float
    floor_z: float

    @property
    def shape(self):
        return self.counts.shape

    def density(self) -> np.ndarray:
        """pts/m² of vertical surface: count / (cell width × slice height)."""
        return self.counts / (self.cell * (self.slice_max - self.slice_min))

    def extent(self) -> tuple[float, float, float, float]:
        ny, nx = self.counts.shape
        return (self.origin[0], self.origin[0] + nx * self.cell, self.origin[1], self.origin[1] + ny * self.cell)


def _floor_peaks(hist: np.ndarray, z0: float) -> list[dict]:
    """Candidate horizontal surfaces: local maxima well above the typical bin."""
    if hist.sum() == 0:
        return []
    k = np.array([1, 2, 1]) / 4
    sm = np.convolve(hist, k, mode="same")
    nz = sm[sm > 0]
    base = np.median(nz) if len(nz) else 0
    thresh = max(5 * base, 0.002 * hist.sum())
    peaks = []
    for i in range(1, len(sm) - 1):
        if sm[i] >= thresh and sm[i] >= sm[i - 1] and sm[i] > sm[i + 1]:
            # refine to the raw-histogram max in ±2 bins
            lo, hi = max(0, i - 2), min(len(hist), i + 3)
            j = lo + int(np.argmax(hist[lo:hi]))
            if peaks and abs(peaks[-1]["bin"] - j) <= 2:
                continue
            peaks.append({"bin": j, "z": z0 + (j + 0.5) * Z_BIN, "count": int(hist[j])})
    return peaks


def detect_floors(hist: np.ndarray, z0: float, min_storey: float = 2.0) -> tuple[list[float], list[dict]]:
    """Floors from the Z histogram.

    A floor has wall bases immediately above it and an empty slab (or nothing)
    immediately below; a ceiling is the reverse; a table top has returns on
    both sides. Windows sit just beyond the surface's own thickness.
    """
    peaks = _floor_peaks(hist, z0)
    nz = hist[hist > 0]
    base = float(np.median(nz)) if len(nz) else 0.0
    win = int(round(0.15 / Z_BIN))
    out = []
    for p in peaks:
        b = p["bin"]
        # extent of the surface itself (noisy or slightly sloped floors are several bins thick)
        edge = max(0.1 * hist[b], 3 * base)
        lo = b
        while lo > 0 and hist[lo - 1] > edge and b - lo < 8:
            lo -= 1
        hi = b
        while hi < len(hist) - 1 and hist[hi + 1] > edge and hi - b < 8:
            hi += 1
        above = hist[hi + 2: hi + 2 + win].sum()
        below = hist[max(0, lo - 1 - win): max(0, lo - 1)].sum()
        p["above"], p["below"] = int(above), int(below)
        p["kind"] = "floor" if above >= 3 * below + 1 else ("ceiling" if below >= 3 * above + 1 else "other")
        out.append(p)
    floors: list[dict] = []
    for p in sorted((p for p in out if p["kind"] == "floor"), key=lambda p: p["z"]):
        if floors and p["z"] - floors[-1]["z"] < min_storey:
            if p["count"] > floors[-1]["count"]:
                floors[-1] = p
            continue
        floors.append(p)
    return [round(f["z"], 3) for f in floors], out


def pass_one(path: str, sample_target: int = 400_000, chunk_size: int = 2_000_000, seed: int = 0) -> dict:
    reader = open_cloud(path)
    header: CloudHeader = reader.header()
    total_hint = max(header.point_count, 1)
    keep_p = min(1.0, sample_target / total_hint)
    rng = np.random.default_rng(seed)
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    # Z histogram over a fixed absolute window (-1000..9000 m, 2 cm bins = 4 MB) so a
    # single pass suffices without trusting header bounds (writers disagree on frames)
    zlo, zhi = -1000.0, 9000.0
    nbins = int(np.ceil((zhi - zlo) / Z_BIN))
    hist = np.zeros(nbins, dtype=np.int64)
    per_scan: dict[int, int] = {}
    samples, sample_scan = [], []
    n_total = 0
    for ch in reader.iter_chunks(chunk_size):
        xyz = ch.xyz
        if not len(xyz):
            continue
        n_total += len(xyz)
        per_scan[ch.scan] = per_scan.get(ch.scan, 0) + len(xyz)
        lo = np.minimum(lo, xyz.min(0))
        hi = np.maximum(hi, xyz.max(0))
        idx = ((xyz[:, 2] - zlo) / Z_BIN).astype(np.int64)
        idx = idx[(idx >= 0) & (idx < nbins)]
        hist += np.bincount(idx, minlength=nbins)
        m = rng.random(len(xyz)) < keep_p
        samples.append(xyz[m].astype(np.float32))
        sample_scan.append(np.full(int(m.sum()), ch.scan, dtype=np.int16))
    if hasattr(reader, "close"):
        reader.close()
    if n_total == 0:
        raise ValueError("The file contains no readable points.")
    # trim histogram to the data
    b0 = max(0, int((lo[2] - zlo) / Z_BIN) - 5)
    b1 = min(nbins, int((hi[2] - zlo) / Z_BIN) + 6)
    hist = hist[b0:b1]
    z0 = zlo + b0 * Z_BIN
    return {
        "header": header, "bounds": (lo.tolist(), hi.tolist()), "z_hist": hist, "z0": z0,
        "per_scan": per_scan, "point_count": n_total,
        "sample": np.concatenate(samples) if samples else np.zeros((0, 3), np.float32),
        "sample_scan": np.concatenate(sample_scan) if sample_scan else np.zeros(0, np.int16),
    }


def pass_two(path: str, floors: list[float], bounds, cell: float, slice_min: float, slice_max: float,
             chunk_size: int = 2_000_000) -> list[Grid]:
    lo, hi = np.asarray(bounds[0]), np.asarray(bounds[1])
    x0 = np.floor(lo[0] / cell) * cell
    y0 = np.floor(lo[1] / cell) * cell
    nx = int(np.ceil((hi[0] - x0) / cell)) + 1
    ny = int(np.ceil((hi[1] - y0) / cell)) + 1
    if nx * ny > 60_000_000:
        raise ValueError(f"Grid of {nx}×{ny} cells is too large; increase the cell size.")
    grids = [np.zeros(ny * nx, dtype=np.int64) for _ in floors]
    reader = open_cloud(path)
    for ch in reader.iter_chunks(chunk_size):
        xyz = ch.xyz
        z = xyz[:, 2]
        for gi, fz in enumerate(floors):
            m = (z >= fz + slice_min) & (z < fz + slice_max)
            if not m.any():
                continue
            ix = ((xyz[m, 0] - x0) / cell).astype(np.int64)
            iy = ((xyz[m, 1] - y0) / cell).astype(np.int64)
            ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
            grids[gi] += np.bincount(iy[ok] * nx + ix[ok], minlength=ny * nx)
    if hasattr(reader, "close"):
        reader.close()
    return [Grid(origin=(float(x0), float(y0)), cell=cell, counts=g.reshape(ny, nx),
                 slice_min=fz + slice_min, slice_max=fz + slice_max, floor_z=fz)
            for g, fz in zip(grids, floors)]
