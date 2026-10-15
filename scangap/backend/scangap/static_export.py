"""Bake one project into static files for the read-only hosted demo.

The UI, built with NEXT_PUBLIC_STATIC_DEMO=1, reads these instead of calling the API.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import loa, project


def export(pid: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    p = project.load(pid)
    res = project.analyze(pid)
    # strip local filesystem paths from what gets published
    p = json.loads(json.dumps(p))
    p["inputs"] = {k: Path(v).name.split("__", 1)[-1] for k, v in p["inputs"].items()}
    res = json.loads(json.dumps(res, default=float))
    if "cloud" in res:
        res["cloud"]["path"] = res["cloud"]["file"]
    for f in (res.get("manifest") or {}).get("files", []):
        f.pop("path", None)
    bundle = {"project": dict(p, readonly=True), "results": res}
    (out / "project.json").write_text(json.dumps(bundle, default=float))
    grids = []
    for i in range(len(res.get("grids", []))):
        grids.append(project.grid_payload(pid, i))
    (out / "grids.json").write_text(json.dumps(grids, default=float))
    # float32 xyz triples, base64 in JSON (static hosts serve .json everywhere; not always .bin)
    import base64
    pts = project.points_bin(pid, 120_000)
    (out / "points.json").write_text(json.dumps({"format": "float32-xyz", "b64": base64.b64encode(pts).decode()}))
    (out / "report.pdf").write_bytes(project.pdf(pid))
    (out / "report.csv").write_text(project.csv_report(pid))
    (out / "health.json").write_text(json.dumps({"ok": True, "llm_available": False, "readonly": True,
                                                 "loa": [b.as_dict() for b in loa.LOA_BANDS.values()]}))
