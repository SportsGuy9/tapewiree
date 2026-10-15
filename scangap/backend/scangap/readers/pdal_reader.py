"""Fallback reader via PDAL's Python bindings (conda-forge: `conda install -c conda-forge pdal python-pdal`).

Used only when pye57 or laspy cannot be imported (pye57 ships wheels for a
limited set of platforms). PDAL reads E57/LAS/LAZ; this reader loads the whole
file, so it is the slow path.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator

import numpy as np

from . import Chunk, CloudHeader, ScanInfo


class PdalReader:
    def __init__(self, path: Path):
        import pdal  # noqa: F401  (raises ImportError with a clear message if missing)

        self.path = Path(path)
        self._arr = None

    def _load(self):
        if self._arr is None:
            import pdal
            p = pdal.Pipeline(json.dumps([str(self.path)]))
            p.execute()
            self._arr = p.arrays[0]
            self._meta = p.metadata
        return self._arr

    def header(self) -> CloudHeader:
        a = self._load()
        xyz = np.column_stack([a["X"], a["Y"], a["Z"]])
        return CloudHeader(
            path=str(self.path), format=self.path.suffix[1:].upper(), reader="PDAL",
            file_size=os.path.getsize(self.path), point_count=len(a),
            scans=[ScanInfo(index=0, name=self.path.stem, point_count=len(a), position=None, has_pose=False)],
            bounds=(xyz.min(0).tolist(), xyz.max(0).tolist()), coordinate_metadata=None,
            units="m (assumed)", fields=list(a.dtype.names),
            read={"points": f"{len(a):,}"},
            absent=["per-scan poses (PDAL merges scans)", "scanner info"],
            notes=["Read with the PDAL fallback; scans are merged."])

    def iter_chunks(self, chunk_size: int = 2_000_000) -> Iterator[Chunk]:
        a = self._load()
        for i in range(0, len(a), chunk_size):
            s = a[i:i + chunk_size]
            yield Chunk(xyz=np.column_stack([s["X"], s["Y"], s["Z"]]).astype(np.float64), scan=0)
