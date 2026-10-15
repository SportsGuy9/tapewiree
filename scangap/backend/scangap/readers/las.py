"""LAS/LAZ reader on laspy (+lazrs for LAZ), streamed with chunk_iterator."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import laspy
import numpy as np

from . import Chunk, CloudHeader, ScanInfo

# VLRs that carry a CRS: OGC WKT (2112), GeoTIFF keys (34735/34736/34737)
_CRS_VLRS = {2112: "OGC WKT", 34735: "GeoKeyDirectory", 34736: "GeoDoubleParams", 34737: "GeoAsciiParams"}


class LasReader:
    format = "LAS"

    def __init__(self, path: Path):
        self.path = Path(path)

    def header(self) -> CloudHeader:
        with laspy.open(self.path) as f:
            h = f.header
            vlrs = list(h.vlrs) + list(getattr(f, "evlrs", None) or [])
            crs_vlrs = [f"{_CRS_VLRS[v.record_id]} ({v.user_id})" for v in vlrs
                        if v.record_id in _CRS_VLRS]
            wkt = None
            for v in vlrs:
                if v.record_id == 2112:
                    try:
                        wkt = v.string if hasattr(v, "string") else bytes(v.record_data).decode(errors="ignore")
                    except Exception:
                        wkt = "present (unparsed)"
            dims = list(h.point_format.dimension_names)
            read = {
                "LAS version": f"{h.version.major}.{h.version.minor}",
                "point format": str(h.point_format.id),
                "points": f"{h.point_count:,}",
                "scale": ", ".join(f"{s:g}" for s in h.scales),
                "offset": ", ".join(f"{o:g}" for o in h.offsets),
                "generating software": (h.generating_software or "").strip("\x00 ") or "—",
                "system identifier": (h.system_identifier or "").strip("\x00 ") or "—",
            }
            absent = []
            if crs_vlrs:
                read["CRS records"] = ", ".join(crs_vlrs)
            else:
                absent.append("CRS VLR (WKT/GeoTIFF)")
            if h.creation_date:
                read["creation date"] = str(h.creation_date)
            else:
                absent.append("creation date")
            absent.append("scanner poses (LAS has no standard field)")
            notes = ["LAS does not store scanner positions; import setups as CSV to run plan checks."]
            if "point_source_id" in dims:
                notes.append("point_source_id is used as the scan index when present.")
            units = None
            if wkt and ("foot" in wkt.lower() or "feet" in wkt.lower()):
                units = "ft (from WKT)"
            elif wkt and "metre" in wkt.lower():
                units = "m (from WKT)"
            if units is None:
                absent.append("linear units (assumed metres)")
            return CloudHeader(
                path=str(self.path), format="LAZ" if self.path.suffix.lower() == ".laz" else "LAS",
                reader=f"laspy {laspy.__version__}", file_size=os.path.getsize(self.path),
                point_count=h.point_count,
                scans=[ScanInfo(index=0, name=self.path.stem, point_count=h.point_count, position=None, has_pose=False)],
                bounds=(list(map(float, h.mins)), list(map(float, h.maxs))),
                coordinate_metadata=wkt, units=units or "m (assumed)", fields=dims,
                read=read, absent=absent, notes=notes)

    def iter_chunks(self, chunk_size: int = 2_000_000) -> Iterator[Chunk]:
        with laspy.open(self.path) as f:
            for pts in f.chunk_iterator(chunk_size):
                xyz = np.column_stack([np.asarray(pts.x), np.asarray(pts.y), np.asarray(pts.z)])
                yield Chunk(xyz=xyz, scan=0)


def write_las(path: str | Path, xyz: np.ndarray, wkt: str | None = None) -> None:
    hdr = laspy.LasHeader(point_format=0, version="1.4")
    hdr.scales = np.array([0.001, 0.001, 0.001])
    hdr.offsets = np.floor(xyz.min(0))
    if wkt:
        # raw WKT VLR (laspy's add_crs needs pyproj; not worth the dependency)
        hdr.vlrs.append(laspy.VLR(user_id="LASF_Projection", record_id=2112, description="OGC WKT",
                                  record_data=wkt.encode() + b"\x00"))
    las = laspy.LasData(hdr)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    las.write(str(path))
