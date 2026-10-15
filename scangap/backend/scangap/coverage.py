"""Per-zone coverage from a slice density grid.

Inside a 0.5–2.0 m slice, open floor area legitimately has no returns; what a
scan must capture there is the zone's bounding walls and whatever stands
against them. So coverage is measured *along each zone's perimeter*: the
boundary is cut into strips one cell long that reach ``wall_band`` metres into
the zone (and a few cm outside, to tolerate a boundary drawn on the wall face).
A strip is covered when the vertical-surface density of returns in it meets the
zone's minimum.

Short runs with (near-)zero returns between covered strips are most likely door
or window openings; they are reported as "probable opening" and left out of the
percentage. Everything else below threshold is a candidate gap, always worded
"possible gap — review": a closed door, furniture or an out-of-scope wall can
all look the same from here.
"""
from __future__ import annotations

import numpy as np
from matplotlib.path import Path as MplPath

from .cloud import Grid
from .models import Finding, Settings, Zone


def _signed_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index runs of True in a 1-D boolean array (non-cyclic)."""
    out = []
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j))
            i = j
        else:
            i += 1
    return out


def perimeter_samples(grid: Grid, polygon, wall_band: float, outside_tol: float):
    """Sample the zone boundary; returns (points[n,2], lengths[n], density[n])."""
    poly = np.asarray(polygon, dtype=float)
    if len(poly) >= 2 and np.allclose(poly[0], poly[-1]):
        poly = poly[:-1]
    if len(poly) < 3:
        raise ValueError("Zone polygon needs at least 3 vertices.")
    ccw = _signed_area(poly) > 0
    counts = grid.counts
    ny, nx = counts.shape
    x0, y0 = grid.origin
    c = grid.cell
    slice_h = grid.slice_max - grid.slice_min
    pts, lens, dens = [], [], []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        d = q - p
        le = float(np.hypot(*d))
        if le < 1e-6:
            continue
        t = d / le
        n = np.array([-t[1], t[0]]) if ccw else np.array([t[1], -t[0]])  # inward normal
        k = max(1, int(round(le / c)))
        s = le / k
        # candidate cells: bbox of the strip
        corners = np.array([p - n * outside_tol, q - n * outside_tol, p + n * wall_band, q + n * wall_band])
        ix0 = max(0, int(np.floor((corners[:, 0].min() - x0) / c)))
        ix1 = min(nx, int(np.ceil((corners[:, 0].max() - x0) / c)) + 1)
        iy0 = max(0, int(np.floor((corners[:, 1].min() - y0) / c)))
        iy1 = min(ny, int(np.ceil((corners[:, 1].max() - y0) / c)) + 1)
        sums = np.zeros(k)
        if ix1 > ix0 and iy1 > iy0:
            gx, gy = np.meshgrid(x0 + (np.arange(ix0, ix1) + 0.5) * c, y0 + (np.arange(iy0, iy1) + 0.5) * c)
            sub = counts[iy0:iy1, ix0:ix1]
            u = (gx - p[0]) * t[0] + (gy - p[1]) * t[1]
            v = (gx - p[0]) * n[0] + (gy - p[1]) * n[1]
            m = (u >= 0) & (u < le) & (v >= -outside_tol) & (v <= wall_band)
            idx = np.minimum((u[m] / s).astype(int), k - 1)
            sums = np.bincount(idx, weights=sub[m].astype(float), minlength=k)
        mids = p + np.outer((np.arange(k) + 0.5) * s, t)
        pts.append(mids)
        lens.append(np.full(k, s))
        dens.append(sums / (s * slice_h))
    return np.vstack(pts), np.concatenate(lens), np.concatenate(dens)


def zone_coverage(grid: Grid, zone: Zone, min_density: float, settings: Settings,
                  max_opening: float = 1.5, setups_xy: list[tuple[str, float, float]] | None = None) -> dict:
    outside_tol = min(0.1, grid.cell * 0.5)
    pts, lens, dens = perimeter_samples(grid, zone.polygon, settings.wall_band, outside_tol)
    covered = dens >= min_density
    empty = dens <= 0
    n = len(dens)
    state = np.where(covered, "covered", np.where(empty, "empty", "weak")).astype(object)

    # rotate so index 0 is a covered sample: makes cyclic runs simple
    start = int(np.argmax(covered)) if covered.any() else 0
    order = np.roll(np.arange(n), -start)
    if covered.any():
        for a, b in _runs(~covered[order]):
            ids = order[a:b]
            run_len = lens[ids].sum()
            before = order[(a - 1) % n]
            after = order[b % n]
            # door/window reveals leave a few returns, so "near-empty", not strictly zero
            if (run_len <= max_opening and covered[before] and covered[after]
                    and dens[ids].max() < 0.5 * min_density):
                state[ids] = "opening"

    eval_mask = state != "opening"
    total_len = float(lens[eval_mask].sum())
    cov_len = float(lens[(state == "covered")].sum())
    pct = 100.0 * cov_len / total_len if total_len > 0 else 0.0

    gaps = []
    bad = (state == "weak") | (state == "empty")
    for a, b in _runs(bad[order]):
        ids = order[a:b]
        L = float(lens[ids].sum())
        if L < settings.min_gap_length:
            continue
        gaps.append({
            "length_m": round(L, 2),
            "path": [[round(float(x), 3), round(float(y), 3)] for x, y in pts[ids]],
            "mean_density": round(float(dens[ids].mean()), 1),
            "kind": "no returns" if (dens[ids] <= 0).all() else "below density",
        })
    gaps.sort(key=lambda g: -g["length_m"])
    openings = []
    for a, b in _runs((state == "opening")[order]):
        ids = order[a:b]
        openings.append({"length_m": round(float(lens[ids].sum()), 2),
                         "at": [round(float(pts[ids].mean(0)[0]), 2), round(float(pts[ids].mean(0)[1]), 2)]})

    # points inside the zone (slice) and setups inside it
    path = MplPath(np.asarray(zone.polygon, float))
    ny, nx = grid.counts.shape
    xs = grid.origin[0] + (np.arange(nx) + 0.5) * grid.cell
    ys = grid.origin[1] + (np.arange(ny) + 0.5) * grid.cell
    gx, gy = np.meshgrid(xs, ys)
    inside = path.contains_points(np.column_stack([gx.ravel(), gy.ravel()])).reshape(ny, nx)
    zone_pts = int(grid.counts[inside].sum())
    setups_inside = [lab for lab, x, y in (setups_xy or []) if path.contains_point((x, y))]

    return {
        "zone": zone.id, "name": zone.name, "floor": zone.floor,
        "coverage_pct": round(pct, 1), "perimeter_m": round(float(lens.sum()), 2),
        "evaluated_m": round(total_len, 2), "covered_m": round(cov_len, 2),
        "min_density": min_density,
        "median_wall_density": round(float(np.median(dens[state == "covered"])) if (state == "covered").any() else 0.0, 1),
        "slice_points": zone_pts, "setups_inside": setups_inside,
        "gaps": gaps, "openings": openings,
        "samples": [[round(float(x), 2), round(float(y), 2), s, round(float(d), 1)]
                    for (x, y), s, d in zip(pts, state, dens)],
    }


def coverage_findings(results: list[dict], zones: list[Zone], settings: Settings) -> list[Finding]:
    out: list[Finding] = []
    zmap = {z.id: z for z in zones}
    for r in results:
        z = zmap[r["zone"]]
        if not z.in_scope:
            continue
        pct = r["coverage_pct"]
        where = f"{r['covered_m']:.1f} of {r['evaluated_m']:.1f} m of perimeter at ≥{r['min_density']:g} pts/m²"
        setups = (f"Setups inside: {', '.join(r['setups_inside'])}." if r["setups_inside"]
                  else "No scan setup inside this zone.")
        if r["slice_points"] == 0 and pct == 0:
            out.append(Finding(module="coverage", severity="high", ref=z.id,
                               title=f"Possible gap — review: {z.name} has no returns",
                               detail=f"No points in the 0.5–2.0 m slice inside the zone. {setups} "
                                      "Could be unscanned, a closed door, or out of scope — confirm on site."))
        elif pct < 50:
            out.append(Finding(module="coverage", severity="high", ref=z.id,
                               title=f"Possible gap — review: {z.name} coverage {pct:.0f}%",
                               detail=f"{where}. {setups}"))
        elif pct < settings.min_zone_coverage_pct:
            out.append(Finding(module="coverage", severity="review", ref=z.id,
                               title=f"Possible gap — review: {z.name} coverage {pct:.0f}%",
                               detail=f"Below the {settings.min_zone_coverage_pct:g}% target. {where}. {setups}"))
        else:
            out.append(Finding(module="coverage", severity="pass", ref=z.id,
                               title=f"{z.name} coverage {pct:.0f}%", detail=where))
            for g in r["gaps"][:3]:
                if g["length_m"] >= 1.0:
                    out.append(Finding(module="coverage", severity="info", ref=z.id,
                                       title=f"Possible gap — review: {g['length_m']:.1f} m in {z.name}",
                                       detail=f"{g['kind']} near ({g['path'][0][0]:.1f}, {g['path'][0][1]:.1f}). "
                                              "Zone passes overall; check for occlusion."))
        if r["openings"]:
            tot = sum(o["length_m"] for o in r["openings"])
            out.append(Finding(module="coverage", severity="info", ref=z.id,
                               title=f"{len(r['openings'])} probable opening(s) in {z.name} excluded",
                               detail=f"{tot:.1f} m of perimeter with (near-)zero returns between covered walls "
                                      "(doorways/glazing, or a short occlusion). Excluded from the percentage."))
    return out
