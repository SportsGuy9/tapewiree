"""Scan plan vs. actual setups."""
from __future__ import annotations

import numpy as np
from matplotlib.path import Path as MplPath
from scipy.optimize import linear_sum_assignment

from .models import Finding, Zone
from .tables import pick, read_csv, to_float


def parse_setups(text: str) -> list[dict]:
    """CSV of setups: label,x,y[,z][,zone]. Header names are matched leniently."""
    header, rows = read_csv(text)
    lab = pick(header, "label", "name", "setup", "station", "id", "scan")
    xk = pick(header, "x", "easting", "e")
    yk = pick(header, "y", "northing", "n")
    zk = pick(header, "z", "elevation", "height")
    zone_k = pick(header, "zone", "zones", "room", "area")
    if not xk or not yk:
        raise ValueError(f"Setup CSV needs x and y columns; found {header}")
    out = []
    for i, r in enumerate(rows):
        x, y = to_float(r.get(xk)), to_float(r.get(yk))
        if x is None or y is None:
            continue
        zones = [s.strip() for s in (r.get(zone_k) or "").replace("|", ";").split(";") if s.strip()] if zone_k else []
        out.append({"label": (r.get(lab) if lab else None) or f"P{i + 1}", "x": x, "y": y,
                    "z": to_float(r.get(zk)) if zk else None, "zones": zones})
    return out


def match_plan(planned: list[dict], actual: list[dict], tolerance: float, zones: list[Zone],
               coverage: dict[str, dict] | None = None) -> dict:
    coverage = coverage or {}
    zmap = {z.id: z for z in zones}
    zname = {z.name.lower(): z.id for z in zones}
    rows, extra = [], []
    if planned and actual:
        P = np.array([[p["x"], p["y"]] for p in planned])
        A = np.array([[a["x"], a["y"]] for a in actual])
        D = np.hypot(P[:, None, 0] - A[None, :, 0], P[:, None, 1] - A[None, :, 1])
        cost = np.where(D <= tolerance, D, 1e6)
        ri, ci = linear_sum_assignment(cost)
        pairs = {int(r): int(c) for r, c in zip(ri, ci) if D[r, c] <= tolerance}
    else:
        D = None
        pairs = {}
    used = set(pairs.values())
    for i, p in enumerate(planned):
        meant = []
        for z in p.get("zones", []):
            zid = z if z in zmap else zname.get(z.lower())
            if zid and zid not in meant:
                meant.append(zid)
        for z in zones:
            if z.id not in meant and MplPath(np.asarray(z.polygon, float)).contains_point((p["x"], p["y"])):
                meant.append(z.id)
        row = {"label": p["label"], "x": p["x"], "y": p["y"], "zones": meant,
               "zone_names": [zmap[z].name for z in meant if z in zmap]}
        if i in pairs:
            a = actual[pairs[i]]
            row.update(status="matched", actual=a["label"], offset_m=round(float(D[i, pairs[i]]), 3),
                       label_agrees=str(a["label"]).strip().lower() == str(p["label"]).strip().lower())
        else:
            near = None
            if D is not None and D.shape[1]:
                j = int(np.argmin(D[i]))
                near = {"label": actual[j]["label"], "distance_m": round(float(D[i, j]), 2)}
            row.update(status="missing", actual=None, offset_m=None, nearest=near)
        rows.append(row)
    for j, a in enumerate(actual):
        if j not in used:
            extra.append({"label": a["label"], "x": a["x"], "y": a["y"]})

    findings: list[Finding] = []
    for r in rows:
        if r["status"] != "missing":
            continue
        cov_bits = []
        for z in r["zones"]:
            c = coverage.get(z)
            if c is not None:
                cov_bits.append(f"{zmap[z].name} coverage {c['coverage_pct']:.0f}%")
        meant = ", ".join(r["zone_names"]) or "no drawn zone"
        near = r.get("nearest")
        findings.append(Finding(
            module="plan", severity="high", ref=r["label"],
            title=f"Planned setup {r['label']} not found",
            detail=f"No actual setup within {tolerance:g} m of ({r['x']:.2f}, {r['y']:.2f}). "
                   f"Meant to cover: {meant}." + (f" {'; '.join(cov_bits)}." if cov_bits else "")
                   + (f" Nearest actual: {near['label']} at {near['distance_m']} m." if near else "")))
    for e in extra:
        findings.append(Finding(module="plan", severity="info", ref=e["label"],
                                title=f"Unplanned setup {e['label']}",
                                detail=f"At ({e['x']:.2f}, {e['y']:.2f}); not within {tolerance:g} m of any planned setup."))
    mism = [r for r in rows if r["status"] == "matched" and not r["label_agrees"]]
    if mism:
        findings.append(Finding(module="plan", severity="info", title=f"{len(mism)} matched setup(s) have different labels",
                                detail="Matched by position; e.g. " + ", ".join(f"{r['label']}→{r['actual']}" for r in mism[:5])))
    if planned and not [f for f in findings if f.severity == "high"]:
        findings.insert(0, Finding(module="plan", severity="pass",
                                   title=f"All {len(planned)} planned setups found within {tolerance:g} m"))
    return {"rows": rows, "unplanned": extra, "tolerance_m": tolerance,
            "matched": sum(r["status"] == "matched" for r in rows),
            "missing": [r["label"] for r in rows if r["status"] == "missing"], "findings": findings}
