"""Delivery package checks.

Each file is either *listed* (we only know its name/size from a manifest) or
*inspected* (we opened it and checked its header). Results always say which.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .models import Deliverable, Finding
from .tables import read_csv, pick, to_float

MAGIC = {
    "e57": b"ASTM-E57",
    "las": b"LASF",
    "laz": b"LASF",
    "pdf": b"%PDF",
    "rvt": b"\xd0\xcf\x11\xe0",  # OLE compound file
    "ifc": b"ISO-10303-21",
    "dwg": b"AC10",
    "zip": b"PK",
}
STOP = {"registered", "point", "cloud", "in", "format", "file", "per", "one", "level", "the", "a", "of", "and", "model", "lod"}


def parse_manifest(text: str, filename: str = "") -> list[dict]:
    """JSON list of {name,size?,path?} or CSV with a name/file column."""
    t = text.strip()
    if t.startswith("[") or t.startswith("{"):
        data = json.loads(t)
        if isinstance(data, dict):
            data = data.get("files", [])
        return [{"name": d["name"] if isinstance(d, dict) else str(d),
                 "size": d.get("size") if isinstance(d, dict) else None,
                 "path": d.get("path") if isinstance(d, dict) else None} for d in data]
    header, rows = read_csv(t)
    nk = pick(header, "name", "file", "filename", "path")
    sk = pick(header, "size", "bytes")
    if not nk:  # plain list, one name per line
        return [{"name": l.strip(), "size": None, "path": None} for l in t.splitlines() if l.strip()]
    return [{"name": Path(r[nk]).name, "size": to_float(r.get(sk)) if sk else None, "path": None} for r in rows]


def scan_folder(folder: str | Path) -> list[dict]:
    root = Path(folder)
    return [{"name": str(p.relative_to(root)), "size": p.stat().st_size, "path": str(p)}
            for p in sorted(root.rglob("*")) if p.is_file()]


def inspect_file(path: str | Path) -> dict:
    p = Path(path)
    ext = p.suffix.lower().lstrip(".")
    res = {"inspected": True, "ok": None, "detail": "", "declares_crs": None}
    try:
        head = p.open("rb").read(64)
    except OSError as e:
        return {"inspected": False, "ok": False, "detail": f"cannot open: {e}", "declares_crs": None}
    want = MAGIC.get(ext)
    if want is not None:
        res["ok"] = head.startswith(want)
        res["detail"] = f"{ext.upper()} signature {'OK' if res['ok'] else 'NOT found — wrong format or corrupt'}"
    else:
        res["detail"] = "opened; no signature check for this type"
    if ext == "e57" and res["ok"]:
        try:
            from .readers.e57 import E57Reader
            h = E57Reader(p).header()
            res["declares_crs"] = bool(h.coordinate_metadata)
            res["detail"] += f"; {len(h.scans)} scans, {h.point_count:,} pts; coordinateMetadata " + \
                             (f"'{h.coordinate_metadata[:60]}'" if h.coordinate_metadata else "empty")
        except Exception as e:
            res["detail"] += f"; header unreadable ({type(e).__name__})"
            res["ok"] = False
    if ext in ("las", "laz") and res["ok"]:
        try:
            from .readers.las import LasReader
            h = LasReader(p).header()
            res["declares_crs"] = "CRS records" in h.read
            res["detail"] += f"; {h.point_count:,} pts; CRS VLR " + ("present" if res["declares_crs"] else "absent")
        except Exception as e:
            res["detail"] += f"; header unreadable ({type(e).__name__})"
            res["ok"] = False
    return res


def _keywords(d: Deliverable) -> list[str]:
    words = re.findall(r"[a-z]{3,}", d.name.lower())
    return [w for w in words if w not in STOP and w != (d.format or "")]


def check_manifest(files: list[dict], deliverables: list[Deliverable], naming_rx: str | None,
                   spec_crs: str | None) -> dict:
    findings: list[Finding] = []
    rows = []
    for f in files:
        name = f["name"]
        ext = Path(name).suffix.lower().lstrip(".")
        row = {"name": name, "ext": ext, "size": f.get("size"), "status": "listed", "detail": "",
               "naming_ok": None, "declares_crs": None, "matches": []}
        if f.get("path") and Path(f["path"]).exists():
            ins = inspect_file(f["path"])
            row.update(status="inspected", detail=ins["detail"], declares_crs=ins["declares_crs"], valid=ins["ok"])
            if ins["ok"] is False:
                findings.append(Finding(module="manifest", severity="high", ref=name,
                                        title=f"{name}: file failed inspection", detail=ins["detail"]))
        if naming_rx:
            row["naming_ok"] = bool(re.match(naming_rx, Path(name).name))
        rows.append(row)

    # deliverable → file matching
    deliv_rows = []
    for d in deliverables:
        fmt = (d.format or "").lower()
        same_fmt = [d2 for d2 in deliverables if (d2.format or "").lower() == fmt]
        cands = [r for r in rows if fmt and (r["ext"] == fmt or (fmt == "rcp" and r["ext"] in ("rcp", "rcs")))]
        if len(same_fmt) > 1:  # disambiguate by keywords (e.g. two PDFs)
            kws = _keywords(d)
            cands = [r for r in cands if any(k in r["name"].lower().replace("_", " ").replace("-", " ") for k in kws)]
        if d.pattern:
            cands = [r for r in rows if re.search(d.pattern, r["name"], re.I)]
        for r in cands:
            r["matches"].append(d.name)
        status = "missing" if not cands else ("inspected" if any(r["status"] == "inspected" for r in cands) else "listed")
        deliv_rows.append({"deliverable": d.name, "format": d.format, "files": [r["name"] for r in cands], "status": status})
        if not cands:
            findings.append(Finding(module="manifest", severity="high", ref=d.name,
                                    title=f"Missing deliverable: {d.name}",
                                    detail=f"No {fmt.upper() or 'matching'} file in the package matches this item."))

    # naming
    bad = [r["name"] for r in rows if r["naming_ok"] is False]
    if bad:
        findings.append(Finding(module="manifest", severity="review", title=f"{len(bad)} file name(s) break the naming convention",
                                detail=", ".join(bad[:10])))
    # duplicates: case-insensitive name, or same stem+size
    seen: dict[str, str] = {}
    for r in rows:
        k = r["name"].lower()
        if k in seen:
            findings.append(Finding(module="manifest", severity="review", ref=r["name"],
                                    title=f"Duplicate: {r['name']} / {seen[k]}",
                                    detail="Same name differing only in case — collides on Windows and is ambiguous."))
        seen[k] = r["name"]
    by_size: dict[tuple, list[str]] = {}
    for r in rows:
        if r["size"]:
            by_size.setdefault((r["ext"], r["size"]), []).append(r["name"])
    for (ext, size), names in by_size.items():
        lowered = {n.lower() for n in names}
        if len(names) > 1 and len(lowered) > 1:
            findings.append(Finding(module="manifest", severity="review", title=f"Possible duplicate content: {', '.join(names)}",
                                    detail=f"Identical size ({int(size):,} bytes)."))
    # formats nobody asked for
    wanted = {(d.format or "").lower() for d in deliverables} | {"rcs"}
    extra = [r["name"] for r in rows if deliverables and r["ext"] not in wanted]
    if extra:
        findings.append(Finding(module="manifest", severity="info", title=f"{len(extra)} file(s) in formats not listed as deliverables",
                                detail=", ".join(extra[:10])))
    # coordinate system declaration
    if not spec_crs:
        findings.append(Finding(module="manifest", severity="review", title="No coordinate system declared for the delivery",
                                detail="Neither the spec nor an accepted requirement states the coordinate system."))
    clouds = [r for r in rows if r["ext"] in ("e57", "las", "laz")]
    for r in clouds:
        if r["status"] == "inspected" and r["declares_crs"] is False:
            findings.append(Finding(module="manifest", severity="review", ref=r["name"],
                                    title=f"{r['name']} does not declare a coordinate system",
                                    detail="Header has no coordinate metadata / CRS record."))
    listed_clouds = [r["name"] for r in clouds if r["status"] == "listed"]
    if listed_clouds:
        findings.append(Finding(module="manifest", severity="info", title="Coordinate declaration not verified for listed-only files",
                                detail=", ".join(listed_clouds) + " — provide the file path to inspect headers."))
    n_ins = sum(r["status"] == "inspected" for r in rows)
    findings.append(Finding(module="manifest", severity="info", title=f"{n_ins} of {len(rows)} files inspected, {len(rows) - n_ins} listed only"))
    return {"files": rows, "deliverables": deliv_rows, "naming_regex": naming_rx, "findings": findings}
