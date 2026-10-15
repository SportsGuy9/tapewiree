"""Registration report checks.

This module never states LOA compliance. Link and target errors describe how
well scans agree *with each other*; compliance needs independent check data.
If the user supplies check points, residuals are reported at 95% confidence
(NSSDA: horizontal 1.7308·RMSE_r, vertical 1.96·RMSE_z) next to the target band.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from . import loa
from .models import Finding
from .tables import pick, read_csv, to_float


def parse_registration(text: str) -> dict:
    header, rows = read_csv(text)
    a_k = pick(header, "from", "scan_a", "station_a", "station1", "scan1", "source", "a", "target_id", "target", "id", "name")
    b_k = pick(header, "to", "scan_b", "station_b", "station2", "scan2", "reference", "b")
    t_k = pick(header, "type", "kind", "constraint", "method")
    o_k = pick(header, "overlap_pct", "overlap")
    e_k = pick(header, "error_mm", "error", "rms_mm", "rms", "residual_mm", "residual", "deviation", "err")
    if not a_k or not e_k:
        raise ValueError(f"Registration CSV needs an id/from column and an error column; found {header}")
    scale, note = 1.0, None
    if e_k.endswith("_m") or e_k in ("error_m", "rms_m"):
        scale, note = 1000.0, "Errors were in metres; converted to mm."
    elif "mm" not in e_k:
        vals = [to_float(r.get(e_k)) for r in rows]
        vals = [v for v in vals if v is not None]
        if vals and np.median(vals) < 0.05:
            scale, note = 1000.0, "Error column had no unit; values < 0.05 assumed metres and converted to mm."
        else:
            note = "Error column had no unit; assumed mm."
    links, targets = [], []
    for i, r in enumerate(rows):
        err = to_float(r.get(e_k))
        if err is None:
            continue
        err *= scale
        a = r.get(a_k, "")
        b = r.get(b_k, "") if b_k else ""
        kind = (r.get(t_k) or "").lower() if t_k else ""
        if b and "target" not in kind:
            links.append({"id": f"{a}–{b}", "a": a, "b": b, "error_mm": round(err, 2),
                          "overlap_pct": to_float(r.get(o_k)) if o_k else None, "type": kind or "link"})
        else:
            targets.append({"id": a or f"T{i + 1}", "error_mm": round(err, 2), "type": kind or "target"})
    return {"links": links, "targets": targets, "unit_note": note}


def _bridges(adj: dict[str, set[str]]) -> set[frozenset]:
    """Edges not on any cycle (Tarjan, iterative)."""
    disc, low, out, t = {}, {}, set(), [0]
    for root in adj:
        if root in disc:
            continue
        stack = [(root, None, iter(adj[root]))]
        disc[root] = low[root] = t[0]
        t[0] += 1
        while stack:
            u, parent, it = stack[-1]
            advanced = False
            for v in it:
                if v == parent:
                    continue
                if v not in disc:
                    disc[v] = low[v] = t[0]
                    t[0] += 1
                    stack.append((v, u, iter(adj[v])))
                    advanced = True
                    break
                low[u] = min(low[u], disc[v])
            if not advanced:
                stack.pop()
                if parent is not None:
                    low[parent] = min(low[parent], low[u])
                    if low[u] > disc[parent]:
                        out.add(frozenset((parent, u)))
    return out


def chains(links: list[dict]) -> list[dict]:
    """Maximal runs of links through degree-2 scans that are not closed by any loop."""
    adj: dict[str, set[str]] = defaultdict(set)
    emap = {}
    for l in links:
        if l["a"] == l["b"]:
            continue
        adj[l["a"]].add(l["b"])
        adj[l["b"]].add(l["a"])
        key = frozenset((l["a"], l["b"]))
        if key not in emap or l["error_mm"] > emap[key]["error_mm"]:
            emap[key] = l
    bridges = _bridges(adj)
    seen: set[frozenset] = set()
    out = []
    for start in adj:
        if len(adj[start]) == 2:
            continue
        for nxt in adj[start]:
            e = frozenset((start, nxt))
            if e in seen:
                continue
            path, cur, prev = [start, nxt], nxt, start
            seen.add(e)
            while len(adj[cur]) == 2:
                (n2,) = adj[cur] - {prev}
                e2 = frozenset((cur, n2))
                if e2 in seen:
                    break
                seen.add(e2)
                prev, cur = cur, n2
                path.append(cur)
            edges = [frozenset((path[i], path[i + 1])) for i in range(len(path) - 1)]
            errs = [emap[e]["error_mm"] for e in edges]
            out.append({"scans": path, "links": len(edges),
                        "unconstrained": all(e in bridges for e in edges),
                        "rss_mm": round(float(np.sqrt(np.sum(np.square(errs)))), 2),
                        "sum_mm": round(float(np.sum(errs)), 2),
                        "link_ids": [emap[e]["id"] for e in edges]})
    return out


def check_registration(reg: dict, tolerance_mm: float, long_chain: int, loa_code: str | None,
                       scan_names: list[str] | None = None) -> dict:
    band = loa.band(loa_code)
    ctx = f" Target band for context: {band.label}." if band else " No LOA defined in spec."
    findings: list[Finding] = []
    over = [l for l in reg["links"] if l["error_mm"] > tolerance_mm]
    for l in sorted(over, key=lambda l: -l["error_mm"]):
        findings.append(Finding(module="registration", severity="review", ref=l["id"],
                                title=f"Link {l['id']} error {l['error_mm']:.1f} mm > {tolerance_mm:g} mm tolerance",
                                detail="Scan-to-scan agreement, not accuracy against control." + ctx))
    for t in reg["targets"]:
        if t["error_mm"] > tolerance_mm:
            findings.append(Finding(module="registration", severity="review", ref=t["id"],
                                    title=f"Target {t['id']} error {t['error_mm']:.1f} mm > {tolerance_mm:g} mm",
                                    detail=ctx.strip()))
    ch = chains(reg["links"])
    over_ids = {l["id"] for l in over}
    long_chains = [c for c in ch if c["unconstrained"] and c["links"] >= long_chain]
    for c in long_chains:
        bad = [i for i in c["link_ids"] if i in over_ids]
        findings.append(Finding(
            module="registration", severity="high" if bad else "review", ref="–".join(c["scans"]),
            title=f"Long single chain: {'–'.join(c['scans'])} ({c['links']} links, no loop closure)",
            detail=f"Error can accumulate along an open chain (e.g. corridors). RSS of link errors "
                   f"{c['rss_mm']:.1f} mm, worst case sum {c['sum_mm']:.1f} mm."
                   + (f" Contains over-tolerance link(s): {', '.join(bad)}." if bad else "")
                   + " Consider a cross-tie or control to close the chain."))
    linked = {l["a"] for l in reg["links"]} | {l["b"] for l in reg["links"]}
    if scan_names:
        orphan = [s for s in scan_names if s not in linked]
        if orphan and reg["links"]:
            findings.append(Finding(module="registration", severity="info",
                                    title=f"{len(orphan)} scan(s) not in the registration report",
                                    detail=", ".join(orphan[:20])))
    if reg.get("unit_note"):
        findings.append(Finding(module="registration", severity="info", title="Units", detail=reg["unit_note"]))
    findings.append(Finding(module="registration", severity="info", title="No LOA compliance statement",
                            detail="Registration errors show internal consistency only. LOA compliance "
                                   "requires independent validation (check points) — see Validation."))
    if not over and not long_chains:
        findings.insert(0, Finding(module="registration", severity="pass",
                                   title=f"All {len(reg['links'])} links within {tolerance_mm:g} mm"))
    errs = [l["error_mm"] for l in reg["links"]]
    return {"links": reg["links"], "targets": reg["targets"], "chains": ch,
            "tolerance_mm": tolerance_mm, "loa": band.as_dict() if band else None,
            "stats": {"n": len(errs), "max_mm": max(errs) if errs else None,
                      "mean_mm": round(float(np.mean(errs)), 2) if errs else None},
            "findings": findings}


def parse_checkpoints(text: str) -> list[dict]:
    header, rows = read_csv(text)
    idk = pick(header, "id", "name", "point", "label")
    cols = {k: pick(header, *c) for k, c in {
        "sx": ("survey_x", "control_x", "known_x", "ref_x"), "sy": ("survey_y", "control_y", "known_y", "ref_y"),
        "sz": ("survey_z", "control_z", "known_z", "ref_z"), "mx": ("scan_x", "measured_x", "cloud_x"),
        "my": ("scan_y", "measured_y", "cloud_y"), "mz": ("scan_z", "measured_z", "cloud_z")}.items()}
    if not all(cols.values()):
        raise ValueError("Check-point CSV needs survey_x,survey_y,survey_z,scan_x,scan_y,scan_z (metres)")
    out = []
    for i, r in enumerate(rows):
        v = {k: to_float(r.get(c)) for k, c in cols.items()}
        if any(x is None for x in v.values()):
            continue
        out.append({"id": r.get(idk) if idk else f"CP{i + 1}", **v})
    return out


def validate_checkpoints(cps: list[dict], loa_code: str | None) -> dict:
    if not cps:
        return {"n": 0, "findings": []}
    d = np.array([[c["mx"] - c["sx"], c["my"] - c["sy"], c["mz"] - c["sz"]] for c in cps]) * 1000.0  # mm
    r = np.hypot(d[:, 0], d[:, 1])
    rmse_r = float(np.sqrt(np.mean(r ** 2)))
    rmse_z = float(np.sqrt(np.mean(d[:, 2] ** 2)))
    h95 = 1.7308 * rmse_r
    v95 = 1.96 * rmse_z
    d3 = np.linalg.norm(d, axis=1)
    p95_3d = float(np.percentile(d3, 95))
    band = loa.band(loa_code)
    findings = []
    n = len(cps)
    if n < 20:
        findings.append(Finding(module="validation", severity="info", title=f"Only {n} check points",
                                detail="NSSDA recommends at least 20 well-distributed check points for a 95% statement."))
    worst = max(h95, v95)
    if band and band.upper_mm is not None:
        sev = "pass" if worst <= band.upper_mm else "review"
        findings.append(Finding(
            module="validation", severity=sev,
            title=f"Check-point residuals @95%: H {h95:.1f} mm, V {v95:.1f} mm vs {band.code} upper {band.upper_mm:g} mm",
            detail=("Within" if sev == "pass" else "Outside") + f" the {band.label} band upper bound for these {n} points. "
                   "A comparison of supplied data, not a certification."))
    else:
        findings.append(Finding(module="validation", severity="info",
                                title=f"Check-point residuals @95%: H {h95:.1f} mm, V {v95:.1f} mm",
                                detail="No LOA band in the spec to compare against."))
    return {"n": n, "rmse_r_mm": round(rmse_r, 2), "rmse_z_mm": round(rmse_z, 2),
            "h95_mm": round(h95, 2), "v95_mm": round(v95, 2), "p95_3d_mm": round(p95_3d, 2),
            "loa_estimate": loa.loa_for_error(worst),
            "points": [{"id": c["id"], "dx_mm": round(a, 2), "dy_mm": round(b, 2), "dz_mm": round(z, 2)}
                       for c, (a, b, z) in zip(cps, d)], "findings": findings}
