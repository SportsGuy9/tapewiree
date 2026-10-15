"""Scope document → requirements, each tied to a verbatim source quote.

Two extractors produce the same schema:

* ``llm``     — Claude with a JSON-schema constrained output (needs ANTHROPIC_API_KEY).
* ``offline`` — deterministic keyword rules; always available, used in demo mode.

Both pass through ``verify_quotes``: a requirement whose quote does not occur in
the document is never used (status "rejected", quote_verified False). Every
extracted requirement starts as "proposed" and only feeds checks after a person
accepts it. Nothing is ever inferred for categories the document doesn't address.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path

from pydantic import BaseModel, ValidationError

from .models import Deliverable, ProjectSpec, Requirement

CATEGORIES = ["intended_use", "loa", "lod", "validation", "coordinate_system", "units",
              "deliverable", "naming", "area", "schedule", "other"]
FORMATS = ["E57", "LAS", "LAZ", "RCP", "RCS", "RVT", "IFC", "DWG", "DXF", "NWD", "NWC", "PTS", "PTX", "PDF", "XLSX", "CSV"]
DEFAULT_MODEL = "claude-opus-5-5"


def extract_text(path: str | Path) -> str:
    p = Path(path)
    if p.suffix.lower() == ".pdf":
        from pypdf import PdfReader
        pages = []
        for i, page in enumerate(PdfReader(str(p)).pages):
            pages.append(f"[page {i + 1}]\n{page.extract_text() or ''}")
        return "\n".join(pages)
    return p.read_text(errors="replace")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[‐-―]", "-", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def verify_quotes(reqs: list[Requirement], text: str) -> list[Requirement]:
    doc = _norm(text)
    out = []
    for r in reqs:
        q = _norm(r.source_quote)
        ok = bool(q) and len(q) >= 8 and q in doc
        r = r.model_copy(update={"quote_verified": ok})
        if not ok:
            r = r.model_copy(update={"status": "rejected"})
        out.append(r)
    return out


# ---------------------------------------------------------------- offline rules

def _sentences(text: str) -> list[str]:
    out = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        for line in lines:
            # keep list items as their own sentence; split prose on ". "
            for s in re.split(r"(?<=[.;])\s+(?=[A-Z])", line):
                if len(s) > 3:
                    out.append(s)
    return out


def extract_offline(text: str) -> list[Requirement]:
    reqs: list[Requirement] = []

    def add(cat, txt, quote, value=None, zone=None):
        reqs.append(Requirement(id=f"R{len(reqs) + 1}", category=cat, text=txt, value=value, zone=zone,
                                source_quote=quote))

    # numbered section headings ("3. Accuracy") become paragraph breaks
    text = re.sub(r"(?m)^\s*\d+(\.\d+)*\.?\s+[A-Z][A-Za-z ,/&\-]{0,40}\s*$", "\n", text)
    sents = _sentences(text)
    # join wrapped lines so multi-line sentences are matched (quotes stay verbatim after normalization)
    joined = re.sub(r"(?<![.:;])\n(?!\s*\n|\s*[a-z]\)|\s*\d+\.)", " ", text)
    para_sents = [s.strip() for s in re.split(r"(?<=[.])\s+|\n", joined) if len(s.strip()) > 3]
    for s in para_sents:
        low = s.lower()
        if re.search(r"will be used for|intended use|purpose of (the )?(scan|survey|work)", low):
            add("intended_use", s, s, value=None)
        for m in re.finditer(r"\bLOA\s?-?(10|20|30|40|50)\b", s, re.I):
            zone = None
            zm = re.search(r"\b(?:Mechanical Room|Mech|Room|Office|Conference|Corridor)\s*\d*\w*", s[:m.start()], re.I)
            if zm and "may be delivered" in low:
                zone = zm.group(0)
            add("loa", f"Measured accuracy {('for ' + zone) if zone else 'requirement'}: LOA{m.group(1)}",
                s, value=f"LOA{m.group(1)}", zone=zone)
        for m in re.finditer(r"\bLOD\s?-?(\d{3})\b", s, re.I):
            add("lod", f"Model level of development LOD {m.group(1)}", s, value=f"LOD {m.group(1)}")
        if re.search(r"validat|check ?points?|independent (check|control)|verification survey", low):
            add("validation", s, s)
        if re.search(r"coordinate system|site grid|local grid|datum|epsg|state plane|nad ?83|osgb|utm", low):
            add("coordinate_system", s, s)
        um = re.search(r"\bunits? (?:in|shall be|of)\s+(us survey feet|feet|metres|meters|millimetres|millimeters)", low)
        if um:
            add("units", f"Units: {um.group(1)}", s, value=um.group(1))
        if re.search(r"naming convention|file names? shall|filenames? shall", low):
            tm = re.search(r"([A-Z0-9][A-Za-z0-9_\-]*<[^>]+>[A-Za-z0-9_\-<>.]*)", s)
            add("naming", s, s, value=tm.group(1).rstrip(".") if tm else None)
        if re.search(r"\b(due|completed? by|deadline)\b", low) and re.search(r"\d{4}-\d{2}-\d{2}|\bdays?\b", low):
            add("schedule", s, s)
    # deliverables: list items mentioning a file format
    for s in sents:
        if re.match(r"^[a-z]\)|^[-•*]\s|^\d+\.\d*\s", s.strip()) or "format" in s.lower():
            fm = [f for f in FORMATS if re.search(rf"\b{f}\b", s)]
            if fm:
                body = re.sub(r"^[a-z]\)\s*|^[-•*]\s*", "", s).strip()
                add("deliverable", body, s, value=fm[0])
    # area/scope sentence
    for s in para_sents:
        if re.search(r"\b(laser )?scan (all|the entire|every)|\barea\b.*\binclud", s, re.I):
            add("area", s, s)
            break
    # de-duplicate (same category + quote)
    seen, out = set(), []
    for r in reqs:
        k = (r.category, r.value, r.zone) if r.category in ("loa", "lod", "units") else (r.category, r.source_quote, r.value)
        if k not in seen:
            seen.add(k)
            out.append(r.model_copy(update={"id": f"R{len(out) + 1}"}))
    return out


# ---------------------------------------------------------------- LLM

class _LLMReq(BaseModel):
    category: str
    text: str
    value: str | None
    zone: str | None
    source_quote: str


class _LLMOut(BaseModel):
    requirements: list[_LLMReq]
    not_addressed: list[str]


_SCHEMA = {
    "type": "object",
    "properties": {
        "requirements": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": CATEGORIES},
                "text": {"type": "string"},
                "value": {"type": ["string", "null"]},
                "zone": {"type": ["string", "null"]},
                "source_quote": {"type": "string"},
            },
            "required": ["category", "text", "value", "zone", "source_quote"],
            "additionalProperties": False}},
        "not_addressed": {"type": "array", "items": {"type": "string", "enum": CATEGORIES}},
    },
    "required": ["requirements", "not_addressed"],
    "additionalProperties": False,
}

_SYSTEM = """You extract requirements from reality-capture (laser scanning) scope-of-work documents.

Rules:
- Extract only requirements the document explicitly states. Never infer, assume, or add industry defaults.
- source_quote must be copied verbatim from the document (a full sentence or list item), so it can be found by exact search.
- One requirement per distinct obligation. Use category:
  intended_use (what the data/model will be used for), loa (USIBD level of accuracy; value like "LOA30"),
  lod (model level of development; value like "LOD 300"), validation (how accuracy will be independently checked),
  coordinate_system, units, deliverable (value = file format like "E57", "RVT", "PDF"), naming (file naming
  convention; value = the pattern as written), area (spaces in or out of scope), schedule, other.
- zone: the room/area a requirement is limited to, as written; null when it applies project-wide.
- List in not_addressed every category from intended_use, loa, lod, validation, coordinate_system, units that the
  document does not address. Missing items matter: they are later flagged for review."""


def llm_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("SCANGAP_OFFLINE", "") not in ("1", "true")


def extract_llm(text: str, model: str | None = None) -> tuple[list[Requirement], list[str]]:
    import anthropic

    client = anthropic.Anthropic()
    resp = client.beta.messages.create(
        model=model or os.environ.get("SCANGAP_MODEL", DEFAULT_MODEL),
        max_tokens=16000,
        system=_SYSTEM,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": _SCHEMA}},
        messages=[{"role": "user", "content": f"<document>\n{text}\n</document>\n\nExtract the requirements."}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model declined to process this document.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("Extraction was cut off (document too long); split the document.")
    raw = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        parsed = _LLMOut.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as e:
        raise RuntimeError(f"Model output failed schema validation: {e}") from e
    reqs = []
    for i, r in enumerate(parsed.requirements):
        cat = r.category if r.category in CATEGORIES else "other"
        reqs.append(Requirement(id=f"R{i + 1}", category=cat, text=r.text, value=r.value, zone=r.zone,
                                source_quote=r.source_quote))
    return reqs, parsed.not_addressed


def extract(text: str, mode: str = "auto") -> dict:
    """Returns {"requirements": [...], "extractor": "llm"|"offline", "not_addressed": [...], "note": str}."""
    note = ""
    if mode in ("auto", "llm") and llm_available():
        try:
            reqs, na = extract_llm(text)
            extractor = "llm"
        except Exception as e:  # network down on site, etc. — fall back, say so
            if mode == "llm":
                raise
            reqs, na = extract_offline(text), None
            extractor, note = "offline", f"LLM extraction failed ({type(e).__name__}); used offline rules."
    else:
        reqs, na = extract_offline(text), None
        extractor = "offline"
        if mode != "offline":
            note = "No ANTHROPIC_API_KEY (or SCANGAP_OFFLINE=1): used offline keyword rules."
    reqs = verify_quotes(reqs, text)
    if na is None:
        present = {r.category for r in reqs if r.quote_verified}
        na = [c for c in ("intended_use", "loa", "lod", "validation", "coordinate_system", "units") if c not in present]
    dropped = sum(not r.quote_verified for r in reqs)
    if dropped:
        note = (note + " " if note else "") + f"{dropped} requirement(s) had quotes not found in the document and were rejected."
    return {"requirements": [r.model_dump() for r in reqs], "extractor": extractor,
            "not_addressed": na, "note": note}


# ---------------------------------------------------------------- applying reviewed requirements

def naming_regex(template: str | None) -> str | None:
    if not template:
        return None
    parts = re.split(r"(<[^>]+>)", template.strip())
    rx = "".join("[^/]+?" if p.startswith("<") else re.escape(p) for p in parts)
    return f"^{rx}$"


def apply_requirements(spec: ProjectSpec, reqs: list[Requirement]) -> tuple[ProjectSpec, list[Deliverable], str | None]:
    """Fill spec gaps from *accepted* requirements only. Never overwrites a value the user typed."""
    acc = [r for r in reqs if r.status == "accepted" and r.quote_verified]
    upd = {}

    def first(cat, pred=lambda r: True):
        return next((r for r in acc if r.category == cat and pred(r)), None)

    if not spec.intended_use and (r := first("intended_use")):
        upd["intended_use"] = r.text
    if not spec.default_loa and (r := first("loa", lambda r: not r.zone and r.value)):
        upd["default_loa"] = r.value
    if not spec.lod and (r := first("lod", lambda r: r.value)):
        upd["lod"] = r.value
    if not spec.validation_method and (r := first("validation")):
        upd["validation_method"] = r.text
    if not spec.coordinate_system and (r := first("coordinate_system")):
        upd["coordinate_system"] = r.text
    if not spec.units and (r := first("units", lambda r: r.value)):
        upd["units"] = r.value
    deliverables = []
    for r in acc:
        if r.category == "deliverable":
            deliverables.append(Deliverable(name=r.text[:80], format=(r.value or "").lower() or None, source=r.id))
    nr = first("naming", lambda r: r.value)
    return spec.model_copy(update=upd), deliverables, naming_regex(nr.value) if nr else None
