"""Project spec checks: accuracy has to be defined before field work, not after."""
from __future__ import annotations

from . import loa
from .models import Finding, ProjectSpec, Zone


def _blank(v: str | None) -> bool:
    return v is None or not str(v).strip()


def check_spec(spec: ProjectSpec, zones: list[Zone]) -> list[Finding]:
    out: list[Finding] = []
    if _blank(spec.intended_use):
        out.append(Finding(
            module="spec", severity="review", title="Intended use not stated",
            detail="Without a stated use (e.g. renovation design, as-built record, clash detection) "
                   "LOA/LOD choices cannot be defended later. Common source of disputes."))

    in_scope = [z for z in zones if z.in_scope]
    zone_loas = {z.id: (z.loa or spec.default_loa) for z in in_scope}
    if _blank(spec.default_loa) and (not in_scope or any(_blank(v) for v in zone_loas.values())):
        missing = [z.name for z in in_scope if _blank(zone_loas[z.id])]
        out.append(Finding(
            module="spec", severity="review", title="Required LOA not defined",
            detail="No project LOA" + (f"; zones without LOA: {', '.join(missing)}" if missing else "")
                   + ". Agree on a USIBD LOA (measured accuracy @95%) before delivery."))
    for zid, code in zone_loas.items():
        if code and loa.band(code) is None:
            out.append(Finding(module="spec", severity="review", title=f"Unrecognized LOA '{code}'",
                               detail="Use LOA10–LOA50 (USIBD).", ref=zid))

    if _blank(spec.validation_method):
        out.append(Finding(
            module="spec", severity="review", title="Validation method not defined",
            detail="LOA can only be demonstrated against independent check data (e.g. total-station "
                   "check points, tape/DISTO checks). Without an agreed method, accuracy claims are "
                   "unverifiable. Common source of disputes."))
    if _blank(spec.coordinate_system):
        out.append(Finding(module="spec", severity="review", title="Coordinate system not declared",
                           detail="State the horizontal/vertical datum or local grid the deliverables use."))
    if _blank(spec.units):
        out.append(Finding(module="spec", severity="info", title="Units not declared",
                           detail="Assumed metres. Watch US survey foot vs international foot."))
    if _blank(spec.lod):
        out.append(Finding(module="spec", severity="info", title="Model LOD not stated",
                           detail="If a model is a deliverable, state its LOD (e.g. LOD 300)."))
    if not out:
        out.append(Finding(module="spec", severity="pass", title="Spec defines use, LOA, validation"))
    return out


def loa_summary(spec: ProjectSpec, zones: list[Zone]) -> list[dict]:
    rows = []
    for z in zones:
        code = z.loa or spec.default_loa
        b = loa.band(code)
        rows.append({"zone": z.id, "name": z.name, "loa": code, "range": b.label if b else None})
    return rows
