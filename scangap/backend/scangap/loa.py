"""USIBD Level of Accuracy (LOA) ranges.

Ranges follow the USIBD Level of Accuracy Specification (v3.0): each level is an
accuracy band stated at the 95% confidence level (2 sigma). The specification
applies separately to *measured* accuracy (the point cloud) and *represented*
accuracy (the model); this tool only ever compares numbers, it never certifies.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LoaBand:
    code: str
    lower_mm: float | None  # tighter bound (smaller number)
    upper_mm: float | None  # looser bound (larger number); None = open-ended

    @property
    def label(self) -> str:
        if self.upper_mm is None:
            return f"{self.code}: > {self.lower_mm:g} mm @95%"
        return f"{self.code}: {self.lower_mm:g}–{self.upper_mm:g} mm @95%"

    def as_dict(self) -> dict:
        return {"code": self.code, "lower_mm": self.lower_mm, "upper_mm": self.upper_mm, "label": self.label}


LOA_BANDS: dict[str, LoaBand] = {
    "LOA10": LoaBand("LOA10", 50.0, None),
    "LOA20": LoaBand("LOA20", 15.0, 50.0),
    "LOA30": LoaBand("LOA30", 5.0, 15.0),
    "LOA40": LoaBand("LOA40", 1.0, 5.0),
    "LOA50": LoaBand("LOA50", 0.0, 1.0),
}


def band(code: str | None) -> LoaBand | None:
    if not code:
        return None
    return LOA_BANDS.get(code.strip().upper().replace(" ", ""))


def loa_for_error(error_mm_95: float) -> str:
    """Tightest LOA band whose upper bound contains a 95% error value."""
    for code in ("LOA50", "LOA40", "LOA30", "LOA20"):
        b = LOA_BANDS[code]
        if b.upper_mm is not None and error_mm_95 <= b.upper_mm:
            return code
    return "LOA10"
