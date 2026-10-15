"""Point-cloud readers.

Every reader exposes the same two things:

* ``header()``  -> ``CloudHeader``: what the file says about itself, split into
  fields that were read and fields that are absent.
* ``iter_chunks(chunk_size)`` -> iterator of ``Chunk`` (global XYZ float64 + scan index),
  so files larger than memory are streamed rather than loaded whole.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import numpy as np


@dataclass
class ScanInfo:
    index: int
    name: str
    point_count: int
    position: tuple[float, float, float] | None  # scanner origin in project coordinates
    has_pose: bool
    rotation: tuple[float, float, float, float] | None = None  # quaternion w,x,y,z
    sensor: dict = field(default_factory=dict)
    acquired: str | None = None


@dataclass
class CloudHeader:
    path: str
    format: str
    reader: str
    file_size: int
    point_count: int
    scans: list[ScanInfo]
    bounds: tuple[list[float], list[float]] | None
    coordinate_metadata: str | None
    units: str | None
    fields: list[str]
    read: dict = field(default_factory=dict)  # field -> human-readable value
    absent: list[str] = field(default_factory=list)  # fields the file did not provide
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "path": self.path, "format": self.format, "reader": self.reader,
            "file_size": self.file_size, "point_count": self.point_count,
            "scans": [s.__dict__ for s in self.scans],
            "bounds": self.bounds, "coordinate_metadata": self.coordinate_metadata,
            "units": self.units, "fields": self.fields, "read": self.read,
            "absent": self.absent, "notes": self.notes,
        }


@dataclass
class Chunk:
    xyz: np.ndarray  # (n, 3) float64, project coordinates
    scan: int


def open_cloud(path: str | Path):
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".e57":
        try:
            from .e57 import E57Reader
            return E57Reader(p)
        except ImportError:
            from .pdal_reader import PdalReader
            return PdalReader(p)
    if ext in (".las", ".laz"):
        try:
            from .las import LasReader
            return LasReader(p)
        except ImportError:
            from .pdal_reader import PdalReader
            return PdalReader(p)
    raise ValueError(f"Unsupported point-cloud format: {ext} (expected .e57, .las, .laz)")
