"""Shared schemas. Everything a check produces is a Finding with a severity."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["high", "review", "info", "pass"]
SEVERITY_ORDER = {"high": 0, "review": 1, "info": 2, "pass": 3}


class Finding(BaseModel):
    module: str  # spec | scan | coverage | plan | registration | scope | manifest | validation
    severity: Severity
    title: str
    detail: str = ""
    ref: str | None = None  # zone id, setup label, link id, file name...


class Zone(BaseModel):
    id: str
    name: str
    polygon: list[tuple[float, float]]
    floor: int = 0  # index into detected floors
    loa: str | None = None  # e.g. "LOA30"; falls back to spec.default_loa
    min_density: float | None = None  # pts/m² on vertical surfaces; falls back to settings
    in_scope: bool = True


class ProjectSpec(BaseModel):
    project_name: str = ""
    client: str = ""
    site: str = ""
    intended_use: str | None = None
    default_loa: str | None = None  # applies to zones without their own LOA
    lod: str | None = None  # LOD of the model deliverable, e.g. "LOD 300"
    validation_method: str | None = None
    coordinate_system: str | None = None
    units: str | None = None
    notes: str = ""


class Settings(BaseModel):
    cell_size: float = 0.25  # m
    slice_min: float = 0.5  # m above floor
    slice_max: float = 2.0
    default_min_density: float = 2000.0  # pts/m² of vertical surface
    min_zone_coverage_pct: float = 90.0
    wall_band: float = 0.75  # m inside each zone boundary where surfaces are expected
    min_gap_length: float = 1.0  # m of perimeter
    plan_tolerance: float = 1.0  # m
    registration_tolerance_mm: float = 6.0
    long_chain_links: int = 3
    floor_override: list[float] | None = None  # manual floor elevations (m)


class Requirement(BaseModel):
    id: str
    category: Literal[
        "intended_use", "loa", "lod", "validation", "coordinate_system", "units",
        "deliverable", "naming", "area", "schedule", "other",
    ]
    text: str  # normalized requirement statement
    value: str | None = None  # e.g. "LOA30", "E57", "EPSG:2272"
    zone: str | None = None
    source_quote: str  # verbatim quote from the scope document
    quote_verified: bool = False
    status: Literal["proposed", "accepted", "rejected"] = "proposed"


class Deliverable(BaseModel):
    name: str
    format: str | None = None  # expected extension, e.g. "e57"
    pattern: str | None = None  # optional filename keyword/regex
    source: str = "manual"  # "manual" | requirement id
