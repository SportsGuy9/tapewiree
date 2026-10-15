"""FastAPI service. Binds to 127.0.0.1 by default: client data never leaves the machine.

Set SCANGAP_READONLY=1 to serve projects without allowing any change (hosted demo).
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, demo, loa, manifest, plan, project, registration, scope
from .models import ProjectSpec, Requirement, Settings, Zone

app = FastAPI(title="ScanGap", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"])

READONLY = os.environ.get("SCANGAP_READONLY", "") in ("1", "true")


@app.middleware("http")
async def readonly_guard(request: Request, call_next):
    if READONLY and request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        return JSONResponse({"detail": "Read-only demo"}, status_code=403)
    return await call_next(request)


def _p(pid: str) -> dict:
    try:
        return project.load(pid)
    except KeyError:
        raise HTTPException(404, "Project not found")


def _bundle(pid: str, rerun: bool = True) -> dict:
    p = _p(pid)
    try:
        res = project.analyze(pid) if rerun else (project.results(pid) or project.analyze(pid))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"project": p, "results": res}


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "llm_available": scope.llm_available(),
            "model": os.environ.get("SCANGAP_MODEL", scope.DEFAULT_MODEL) if scope.llm_available() else None,
            "readonly": READONLY, "loa": [b.as_dict() for b in loa.LOA_BANDS.values()]}


@app.get("/api/projects")
def projects():
    return project.list_projects()


@app.post("/api/projects")
def create_project(body: dict = Body(...)):
    name = (body.get("name") or "").strip() or "Untitled project"
    return project.create(name)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _bundle(pid, rerun=False)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _p(pid)
    project.delete(pid)
    return {"ok": True}


@app.put("/api/projects/{pid}/spec")
def put_spec(pid: str, body: ProjectSpec):
    p = _p(pid)
    p["spec"] = body.model_dump()
    if body.project_name:
        p["name"] = body.project_name
    project.save(p)
    return _bundle(pid)


@app.put("/api/projects/{pid}/settings")
def put_settings(pid: str, body: Settings):
    p = _p(pid)
    p["settings"] = body.model_dump()
    project.save(p)
    return _bundle(pid)


@app.put("/api/projects/{pid}/zones")
def put_zones(pid: str, body: list[Zone]):
    p = _p(pid)
    ids = [z.id for z in body]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "Zone ids must be unique")
    p["zones"] = [z.model_dump() for z in body]
    project.save(p)
    return _bundle(pid)


@app.put("/api/projects/{pid}/signoff")
def put_signoff(pid: str, body: dict = Body(...)):
    p = _p(pid)
    p["signoff"] = {"reviewer": str(body.get("reviewer", ""))[:120], "date": str(body.get("date", ""))[:40]}
    project.save(p)
    return {"ok": True, "signoff": p["signoff"]}


@app.post("/api/projects/{pid}/cloud")
async def upload_cloud(pid: str, file: UploadFile | None = File(None), path: str | None = Form(None)):
    """Either a local path (preferred for multi-GB files: nothing is copied) or an upload."""
    _p(pid)
    if path:
        target = Path(path).expanduser()
    elif file is not None:
        ext = Path(file.filename or "").suffix.lower()
        if ext not in (".e57", ".las", ".laz"):
            raise HTTPException(400, "Expected .e57, .las or .laz")
        target = project._pdir(pid) / "inputs" / f"cloud{ext}"
        with open(target, "wb") as f:
            while chunk := await file.read(8 << 20):
                f.write(chunk)
    else:
        raise HTTPException(400, "Provide a file or a local path")
    try:
        project.ingest_cloud(pid, str(target))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))
    return _bundle(pid)


_PARSERS = {
    "plan": plan.parse_setups,
    "poses": plan.parse_setups,
    "registration": registration.parse_registration,
    "checkpoints": registration.parse_checkpoints,
}


@app.post("/api/projects/{pid}/inputs/{kind}")
async def upload_input(pid: str, kind: str, file: UploadFile = File(...)):
    _p(pid)
    data = await file.read()
    if kind in _PARSERS:
        try:
            _PARSERS[kind](data.decode("utf-8", errors="replace"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        path = project.store_input(pid, kind, file.filename or f"{kind}.csv", data)
        p = project.load(pid)
        p["inputs"][kind] = str(path)
        project.save(p)
    elif kind == "zones":
        try:
            import json
            raw = json.loads(data)
            zones = [Zone(**z) for z in (raw["zones"] if isinstance(raw, dict) else raw)]
        except Exception as e:
            raise HTTPException(400, f"Zones JSON invalid: {e}")
        p = project.load(pid)
        p["zones"] = [z.model_dump() for z in zones]
        project.save(p)
    elif kind == "manifest":
        try:
            files = manifest.parse_manifest(data.decode("utf-8", errors="replace"), file.filename or "")
        except Exception as e:
            raise HTTPException(400, f"Manifest invalid: {e}")
        project.set_manifest_files(pid, files)
    elif kind == "scope":
        ext = Path(file.filename or "").suffix.lower()
        if ext not in (".pdf", ".txt", ".md"):
            raise HTTPException(400, "Scope must be PDF or TXT")
        path = project.store_input(pid, "scope", file.filename or "scope.txt", data)
        try:
            project.set_scope(pid, path)
        except RuntimeError as e:
            raise HTTPException(502, str(e))
    else:
        raise HTTPException(404, f"Unknown input kind {kind}")
    return _bundle(pid)


@app.delete("/api/projects/{pid}/inputs/{kind}")
def remove_input(pid: str, kind: str):
    p = _p(pid)
    p["inputs"].pop(kind, None)
    if kind == "scope":
        p["scope"], p["requirements"] = None, []
    project.save(p)
    return _bundle(pid)


@app.post("/api/projects/{pid}/manifest/folder")
def manifest_folder(pid: str, body: dict = Body(...)):
    folder = Path(body.get("path", "")).expanduser()
    if not folder.is_dir():
        raise HTTPException(400, "Not a folder")
    project.set_manifest_files(pid, manifest.scan_folder(folder))
    return _bundle(pid)


@app.put("/api/projects/{pid}/requirements")
def put_requirements(pid: str, body: list[Requirement]):
    p = _p(pid)
    old = {r["id"]: r for r in p["requirements"]}
    out = []
    for r in body:
        o = old.get(r.id)
        if o is None:
            continue
        # quotes and verification come from extraction only; reviewers change status/text/value
        upd = dict(o, status=r.status, text=r.text, value=r.value, zone=r.zone)
        if not o["quote_verified"] and r.status == "accepted":
            raise HTTPException(400, f"{r.id}: quote not found in the document; cannot accept")
        out.append(upd)
    p["requirements"] = out
    project.save(p)
    return _bundle(pid)


@app.post("/api/projects/{pid}/requirements/apply")
def apply_reqs(pid: str):
    _p(pid)
    project.apply_requirements(pid)
    return _bundle(pid)


@app.put("/api/projects/{pid}/deliverables")
def put_deliverables(pid: str, body: dict = Body(...)):
    """{"deliverables": [{name, format, pattern}], "naming_regex": str | null}"""
    p = _p(pid)
    p["deliverables"] = [{"name": d.get("name", ""), "format": (d.get("format") or "").lower() or None,
                          "pattern": d.get("pattern") or None, "source": d.get("source", "manual")}
                         for d in body.get("deliverables", [])]
    if "naming_regex" in body:
        rx = body["naming_regex"] or None
        if rx:
            import re
            try:
                re.compile(rx)
            except re.error as e:
                raise HTTPException(400, f"Invalid naming regex: {e}")
        p["naming_regex"] = rx
    project.save(p)
    return _bundle(pid)


@app.post("/api/projects/{pid}/analyze")
def analyze(pid: str):
    return _bundle(pid)


@app.get("/api/projects/{pid}/grid/{floor}")
def grid(pid: str, floor: int):
    _p(pid)
    g = project.grid_payload(pid, floor)
    if g is None:
        raise HTTPException(404, "No grid for this floor")
    return g


@app.get("/api/projects/{pid}/points.bin")
def points(pid: str, n: int = 150_000):
    _p(pid)
    return Response(project.points_bin(pid, min(max(n, 1000), 1_000_000)), media_type="application/octet-stream")


@app.get("/api/projects/{pid}/heatmap.png")
def heatmap(pid: str, floor: int = 0):
    _p(pid)
    png = project.heatmap_png(pid, floor)
    if png is None:
        raise HTTPException(404, "No grid")
    return Response(png, media_type="image/png")


@app.get("/api/projects/{pid}/report.pdf")
def report_pdf(pid: str):
    p = _p(pid)
    fn = "".join(c if c.isalnum() else "_" for c in p["name"])[:60]
    return Response(project.pdf(pid), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="ScanGap_{fn}.pdf"'})


@app.get("/api/projects/{pid}/report.csv")
def report_csv(pid: str):
    p = _p(pid)
    fn = "".join(c if c.isalnum() else "_" for c in p["name"])[:60]
    return Response(project.csv_report(pid), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="ScanGap_{fn}.csv"'})


@app.post("/api/demo/{which}")
def build_demo(which: str):
    try:
        if which == "synthetic":
            demo.build_synthetic()
            return {"id": demo.SYNTH_ID}
        if which == "edinburgh":
            demo.build_edinburgh()
            return {"id": demo.EDI_ID}
    except Exception as e:  # download failure etc.
        raise HTTPException(502, f"{type(e).__name__}: {e}")
    raise HTTPException(404, "Unknown demo")


# The built UI (Next.js static export) is served from the same process.
_ui = Path(os.environ.get("SCANGAP_UI_DIR", Path(__file__).resolve().parents[2] / "frontend" / "out"))
if _ui.is_dir():
    app.mount("/", StaticFiles(directory=_ui, html=True), name="ui")
