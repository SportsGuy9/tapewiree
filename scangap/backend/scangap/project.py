"""Local project store and the analysis pipeline.

Layout under $SCANGAP_DATA (default ~/.scangap):

    projects/<id>/project.json   spec, settings, zones, requirements, inputs, sign-off
    projects/<id>/inputs/        uploaded CSV/PDF/TXT (point clouds can stay where they are)
    projects/<id>/cache/         pass-1/pass-2 results (histograms, grids, viewer sample)
    projects/<id>/results.json   last analysis

Reading the point cloud is the slow step and is cached; every other check
(zones, plan, registration, scope, manifest) re-runs in milliseconds.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path

import numpy as np

from . import cloud as cloudmod
from . import coverage, loa, manifest, plan, registration, report, scope, spec as specmod
from .models import SEVERITY_ORDER, Deliverable, Finding, ProjectSpec, Requirement, Settings, Zone


def data_root() -> Path:
    root = Path(os.environ.get("SCANGAP_DATA", Path.home() / ".scangap"))
    (root / "projects").mkdir(parents=True, exist_ok=True)
    return root


def _pdir(pid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{1,64}", pid):
        raise KeyError(pid)
    return data_root() / "projects" / pid


def list_projects() -> list[dict]:
    out = []
    for d in sorted((data_root() / "projects").iterdir()):
        pj = d / "project.json"
        if pj.exists():
            p = json.loads(pj.read_text())
            res = d / "results.json"
            verdict = json.loads(res.read_text()).get("verdict") if res.exists() else None
            out.append({"id": p["id"], "name": p["name"], "created": p.get("created"), "verdict": verdict,
                        "readonly": p.get("readonly", False)})
    return out


def create(name: str, pid: str | None = None) -> dict:
    pid = pid or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] + "-" + uuid.uuid4().hex[:6]
    d = _pdir(pid)
    if d.exists():
        shutil.rmtree(d)
    (d / "inputs").mkdir(parents=True)
    (d / "cache").mkdir()
    p = {"id": pid, "name": name, "created": report.now_iso(), "spec": ProjectSpec(project_name=name).model_dump(),
         "settings": Settings().model_dump(), "zones": [], "requirements": [], "scope": None, "deliverables": [],
         "naming_regex": None, "signoff": {"reviewer": "", "date": ""}, "inputs": {}, "credit": "", "readonly": False}
    save(p)
    return p


def load(pid: str) -> dict:
    pj = _pdir(pid) / "project.json"
    if not pj.exists():
        raise KeyError(pid)
    return json.loads(pj.read_text())


def save(p: dict) -> None:
    d = _pdir(p["id"])
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(p, indent=2))
    tmp.replace(d / "project.json")


def delete(pid: str) -> None:
    shutil.rmtree(_pdir(pid), ignore_errors=True)


def store_input(pid: str, kind: str, filename: str, data: bytes) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._\-]+", "_", Path(filename).name) or kind
    path = _pdir(pid) / "inputs" / f"{kind}__{safe}"
    path.write_bytes(data)
    return path


def results(pid: str) -> dict | None:
    f = _pdir(pid) / "results.json"
    return json.loads(f.read_text()) if f.exists() else None


# ------------------------------------------------------------------ point cloud

def _grid_key(s: Settings, floors: list[float]) -> str:
    return json.dumps([s.cell_size, s.slice_min, s.slice_max, floors])


def ingest_cloud(pid: str, path: str) -> dict:
    p = load(pid)
    path = str(Path(path).expanduser().resolve())
    if not Path(path).exists():
        raise FileNotFoundError(path)
    cache = _pdir(pid) / "cache"
    r1 = cloudmod.pass_one(path)
    floors, peaks = cloudmod.detect_floors(r1["z_hist"], r1["z0"])
    hdr = r1["header"].as_dict()
    meta = {"file": path, "header": hdr, "bounds": r1["bounds"], "floors_detected": floors, "z0": r1["z0"],
            "peaks": peaks, "per_scan": {str(k): v for k, v in r1["per_scan"].items()}, "point_count": r1["point_count"]}
    np.save(cache / "z_hist.npy", r1["z_hist"])
    np.save(cache / "sample.npy", r1["sample"])
    np.save(cache / "sample_scan.npy", r1["sample_scan"])
    (cache / "cloud.json").write_text(json.dumps(meta, default=float))
    (cache / "grids.npz").unlink(missing_ok=True)
    p["inputs"]["cloud"] = path
    save(p)
    ensure_grids(pid)
    return meta


def cloud_meta(pid: str) -> dict | None:
    f = _pdir(pid) / "cache" / "cloud.json"
    return json.loads(f.read_text()) if f.exists() else None


def floors_for(p: dict, meta: dict) -> list[float]:
    s = Settings(**p["settings"])
    if s.floor_override:
        return list(s.floor_override)
    if meta["floors_detected"]:
        return meta["floors_detected"]
    return [round(meta["bounds"][0][2], 3)]  # fall back to the lowest point


def ensure_grids(pid: str) -> list[cloudmod.Grid]:
    p = load(pid)
    meta = cloud_meta(pid)
    if meta is None:
        return []
    s = Settings(**p["settings"])
    floors = floors_for(p, meta)
    gf = _pdir(pid) / "cache" / "grids.npz"
    key = _grid_key(s, floors)
    if gf.exists():
        z = np.load(gf, allow_pickle=False)
        if str(z["key"]) == key:
            return [cloudmod.Grid(origin=tuple(z["origin"]), cell=float(z["cell"]), counts=z[f"c{i}"],
                                  slice_min=fz + s.slice_min, slice_max=fz + s.slice_max, floor_z=fz)
                    for i, fz in enumerate(floors)]
    grids = cloudmod.pass_two(meta["file"], floors, meta["bounds"], s.cell_size, s.slice_min, s.slice_max)
    np.savez_compressed(gf, key=key, origin=np.array(grids[0].origin), cell=grids[0].cell,
                        **{f"c{i}": g.counts for i, g in enumerate(grids)})
    return grids


def actual_setups(p: dict, meta: dict | None) -> tuple[list[dict], str]:
    """Scanner positions: an imported poses CSV wins; otherwise poses from the file header."""
    if p["inputs"].get("poses"):
        rows = plan.parse_setups(Path(p["inputs"]["poses"]).read_text())
        return [{"label": r["label"], "x": r["x"], "y": r["y"]} for r in rows], "poses CSV"
    if meta:
        out = [{"label": s["name"], "x": s["position"][0], "y": s["position"][1]}
               for s in meta["header"]["scans"] if s.get("has_pose") and s.get("position")]
        if out:
            return out, "file header poses"
    return [], "none"


# ------------------------------------------------------------------ analysis

def _verdict(findings: list[Finding]) -> dict:
    counts = {k: 0 for k in SEVERITY_ORDER}
    for f in findings:
        counts[f.severity] += 1
    if counts["high"]:
        level, head = "high", f"Not ready to demobilize — {counts['high']} high-severity item{'s' * (counts['high'] != 1)} to resolve"
    elif counts["review"]:
        level, head = "review", f"Review {counts['review']} item{'s' * (counts['review'] != 1)} before demobilizing"
    else:
        level, head = "pass", "No blocking items found"
    return {"level": level, "headline": head, "counts": counts}


def analyze(pid: str) -> dict:
    p = load(pid)
    s = Settings(**p["settings"])
    sp = ProjectSpec(**p["spec"])
    zones = [Zone(**z) for z in p["zones"]]
    reqs = [Requirement(**r) for r in p["requirements"]]
    findings: list[Finding] = []
    out: dict = {"analyzed_at": report.now_iso(), "credit": p.get("credit", "")}

    findings += specmod.check_spec(sp, zones)
    out["spec_loa"] = specmod.loa_summary(sp, zones)
    b = loa.band(sp.default_loa)
    out["loa_label"] = b.label if b else None
    out["loa_table"] = [v.as_dict() for v in loa.LOA_BANDS.values()]

    # scope
    if p.get("scope"):
        pending = [r for r in reqs if r.status == "proposed"]
        if pending:
            findings.append(Finding(module="scope", severity="review",
                                    title=f"{len(pending)} extracted requirement(s) awaiting review",
                                    detail="Extracted requirements only feed checks after a person accepts them."))
        for cat in p["scope"].get("not_addressed", []):
            if cat in ("intended_use", "loa", "validation"):
                findings.append(Finding(module="scope", severity="review",
                                        title=f"Scope document does not address {cat.replace('_', ' ')}",
                                        detail="Ask the client to confirm in writing before delivery."))
        rejected = [r for r in reqs if not r.quote_verified]
        if rejected:
            findings.append(Finding(module="scope", severity="info",
                                    title=f"{len(rejected)} extracted item(s) discarded: quote not found in document"))

    # cloud + coverage
    meta = cloud_meta(pid)
    setups, setup_src = actual_setups(p, meta)
    zone_res: dict[str, dict] = {}
    if meta:
        grids = ensure_grids(pid)
        hdr = meta["header"]
        floors = floors_for(p, meta)
        out["cloud"] = {"file": Path(meta["file"]).name, "path": meta["file"], "format": hdr["format"],
                        "reader": hdr["reader"], "points": meta["point_count"], "scans": len(hdr["scans"]),
                        "scans_with_pose": sum(sc["has_pose"] for sc in hdr["scans"]),
                        "floors": floors, "floors_detected": meta["floors_detected"],
                        "floor_source": "manual" if s.floor_override else ("Z histogram" if meta["floors_detected"] else "lowest point (no floor peak)"),
                        "bounds": meta["bounds"], "read": hdr["read"], "absent": hdr["absent"], "notes": hdr["notes"],
                        "coordinate_metadata": hdr["coordinate_metadata"], "units": hdr["units"],
                        "slice": f"{s.slice_min:g}–{s.slice_max:g} m", "cell": s.cell_size,
                        "file_size": hdr["file_size"], "setup_source": setup_src,
                        "scan_list": [{"name": sc["name"], "points": sc["point_count"], "position": sc["position"]}
                                      for sc in hdr["scans"]][:500]}
        if not meta["floors_detected"] and not s.floor_override:
            findings.append(Finding(module="scan", severity="review", title="No floor level detected",
                                    detail="Using the lowest point as the floor; set floor elevations manually in Settings."))
        if hdr["coordinate_metadata"] is None:
            findings.append(Finding(module="scan", severity="info", title="Point cloud declares no coordinate system",
                                    detail="No coordinate metadata / CRS record in the file header."))
        for n in hdr["notes"]:
            if "Single scan without a pose" in n:
                findings.append(Finding(module="scan", severity="info", title="Merged cloud — no scanner positions", detail=n))
        xy = [(a["label"], a["x"], a["y"]) for a in setups]
        zres = []
        for z in zones:
            if z.floor >= len(grids):
                findings.append(Finding(module="coverage", severity="review", ref=z.id,
                                        title=f"{z.name}: floor {z.floor} not found", detail=f"Detected floors: {floors}"))
                continue
            md = z.min_density or s.default_min_density
            r = coverage.zone_coverage(grids[z.floor], z, md, s, setups_xy=xy)
            code = z.loa or sp.default_loa
            bb = loa.band(code)
            r.update(loa=code, loa_range=bb.label if bb else None, in_scope=z.in_scope)
            zres.append(r)
            zone_res[z.id] = r
        cf = coverage.coverage_findings(zres, zones, s)
        for r in zres:
            sev = [f.severity for f in cf if f.ref == r["zone"] and f.severity in ("high", "review", "pass")]
            r["severity"] = sev[0] if sev else "info"
        findings += cf
        out["zones"] = zres
        out["grids"] = [{"floor": i, "z": g.floor_z, "origin": g.origin, "cell": g.cell, "shape": list(g.shape)}
                        for i, g in enumerate(grids)]
        if not zones:
            findings.append(Finding(module="coverage", severity="review", title="No zones defined",
                                    detail="Draw zones on the heatmap or import zones JSON to get per-zone coverage."))
    else:
        findings.append(Finding(module="scan", severity="review", title="No point cloud loaded"))
    out["setups"] = setups

    # plan vs actual
    if p["inputs"].get("plan"):
        planned = plan.parse_setups(Path(p["inputs"]["plan"]).read_text())
        pr = plan.match_plan(planned, setups, s.plan_tolerance, zones, zone_res)
        if not setups:
            pr["findings"].insert(0, Finding(module="plan", severity="review", title="No actual setup positions",
                                             detail="The point cloud has no scan poses; import a poses CSV."))
        findings += pr.pop("findings")
        out["plan"] = pr

    # registration
    if p["inputs"].get("registration"):
        reg = registration.parse_registration(Path(p["inputs"]["registration"]).read_text())
        worst_loa = sp.default_loa
        rr = registration.check_registration(reg, s.registration_tolerance_mm, s.long_chain_links, worst_loa,
                                             [a["label"] for a in setups])
        findings += rr["findings"]
        rr["findings"] = [f.model_dump() for f in rr["findings"]]
        out["registration"] = rr
    if p["inputs"].get("checkpoints"):
        cps = registration.parse_checkpoints(Path(p["inputs"]["checkpoints"]).read_text())
        vr = registration.validate_checkpoints(cps, sp.default_loa)
        findings += vr["findings"]
        vr["findings"] = [f.model_dump() for f in vr["findings"]]
        out["validation"] = vr

    # manifest
    if p["inputs"].get("manifest"):
        files = json.loads(Path(p["inputs"]["manifest"]).read_text())
        delivs = [Deliverable(**d) for d in p.get("deliverables", [])]
        mr = manifest.check_manifest(files, delivs, p.get("naming_regex"), sp.coordinate_system)
        findings += mr.pop("findings")
        out["manifest"] = mr

    findings.sort(key=lambda f: SEVERITY_ORDER[f.severity])
    out["findings"] = [f.model_dump() for f in findings]
    out["verdict"] = _verdict(findings)
    (_pdir(pid) / "results.json").write_text(json.dumps(out, indent=1, default=float))
    return out


# ------------------------------------------------------------------ products

def heatmap_png(pid: str, floor: int = 0) -> bytes | None:
    p = load(pid)
    res = results(pid) or analyze(pid)
    grids = ensure_grids(pid)
    if not grids or floor >= len(grids):
        return None
    g = grids[floor]
    g.floor_index = floor  # type: ignore[attr-defined]
    zr = {z["zone"]: z for z in res.get("zones", [])}
    return report.heatmap_png(g, p["zones"], zr, res.get("setups", []), (res.get("plan") or {}).get("rows", []))


def pdf(pid: str) -> bytes:
    p = load(pid)
    res = analyze(pid)
    return report.report_pdf(p, res, heatmap_png(pid, 0))


def csv_report(pid: str) -> str:
    return report.report_csv(load(pid), analyze(pid))


def grid_payload(pid: str, floor: int) -> dict | None:
    grids = ensure_grids(pid)
    if floor >= len(grids):
        return None
    g = grids[floor]
    import base64
    dens = g.density().astype(np.float32)
    return {"floor": floor, "z": g.floor_z, "origin": g.origin, "cell": g.cell, "nx": g.shape[1], "ny": g.shape[0],
            "slice": [g.slice_min, g.slice_max], "density_b64": base64.b64encode(dens.tobytes()).decode(),
            "p99": float(np.percentile(dens[dens > 0], 99)) if (dens > 0).any() else 1.0}


def points_bin(pid: str, max_points: int = 150_000) -> bytes:
    cache = _pdir(pid) / "cache"
    f = cache / "sample.npy"
    if not f.exists():
        return b""
    s = np.load(f)
    if len(s) > max_points:
        s = s[np.random.default_rng(0).choice(len(s), max_points, replace=False)]
    return s.astype(np.float32).tobytes()


# ------------------------------------------------------------------ scope & manifest helpers

def set_scope(pid: str, path: Path, mode: str = "auto") -> dict:
    p = load(pid)
    text = scope.extract_text(path)
    ex = scope.extract(text, mode=mode)
    p["requirements"] = ex["requirements"]
    p["scope"] = {"file": path.name.split("__", 1)[-1], "extractor": ex["extractor"], "note": ex["note"],
                  "not_addressed": ex["not_addressed"], "chars": len(text)}
    p["inputs"]["scope"] = str(path)
    save(p)
    return p


def apply_requirements(pid: str) -> dict:
    p = load(pid)
    reqs = [Requirement(**r) for r in p["requirements"]]
    new_spec, delivs, rx = scope.apply_requirements(ProjectSpec(**p["spec"]), reqs)
    p["spec"] = new_spec.model_dump()
    manual = [d for d in p.get("deliverables", []) if d.get("source") == "manual"]
    p["deliverables"] = manual + [d.model_dump() for d in delivs]
    if rx:
        p["naming_regex"] = rx
    # zone-limited LOA requirements (e.g. "Mechanical Room 104 may be delivered at LOA20")
    for r in reqs:
        if r.status == "accepted" and r.category == "loa" and r.zone and r.value:
            key = re.sub(r"[^a-z0-9]", "", r.zone.lower())
            for z in p["zones"]:
                nm = re.sub(r"[^a-z0-9]", "", z["name"].lower())
                num = re.findall(r"\d{2,}", z["name"])
                if (nm and (nm in key or key in nm)) or (num and num[0] in key):
                    z["loa"] = r.value
    save(p)
    return p


def set_manifest_files(pid: str, files: list[dict]) -> None:
    p = load(pid)
    path = _pdir(pid) / "inputs" / "manifest.json"
    path.write_text(json.dumps(files, indent=1))
    p["inputs"]["manifest"] = str(path)
    save(p)
