"""E57 reader on pye57/libE57, streamed in blocks with per-scan poses applied."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import numpy as np
import pye57
from pye57 import libe57

from . import Chunk, CloudHeader, ScanInfo

try:
    from pye57.__version__ import __version__ as _PYE57_VERSION
except ImportError:  # pragma: no cover
    _PYE57_VERSION = "?"


def _val(node, key):
    try:
        child = node[key]
    except Exception:
        return None
    try:
        return child.value()
    except Exception:
        return child


def _quat_to_matrix(q) -> np.ndarray:
    w, x, y, z = q
    n = np.sqrt(w * w + x * x + y * y + z * z) or 1.0
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


class E57Reader:
    format = "E57"

    def __init__(self, path: Path):
        self.path = Path(path)
        self._e57 = pye57.E57(str(self.path))

    def close(self):
        self._e57.close()

    def header(self) -> CloudHeader:
        e = self._e57
        root = e.root
        scans: list[ScanInfo] = []
        absent: set[str] = set()
        total = 0
        lo = np.full(3, np.inf)
        hi = np.full(3, -np.inf)
        fields: set[str] = set()
        for i in range(e.scan_count):
            h = e.get_header(i)
            node = h.node
            n = h.point_count
            total += n
            fields.update(h.point_fields)
            has_pose = h.has_pose()
            pos = tuple(float(v) for v in h.translation) if has_pose else None
            sensor = {}
            for k in ("sensorVendor", "sensorModel", "sensorSerialNumber", "sensorSoftwareVersion",
                      "sensorFirmwareVersion"):
                v = _val(node, k)
                if isinstance(v, str) and v:
                    sensor[k] = v
                else:
                    absent.add(k)
            acq = _val(node, "acquisitionStart")
            acquired = None
            if acq is not None and not isinstance(acq, (str, float, int)):
                dt = _val(acq, "dateTimeValue")
                if isinstance(dt, float) and dt > 0:
                    acquired = f"GPS time {dt:.0f}"
            if acquired is None:
                absent.add("acquisitionStart")
            if not has_pose:
                absent.add("pose")
            name = _val(node, "name")
            scans.append(ScanInfo(index=i, name=name if isinstance(name, str) else f"Scan {i}",
                                  point_count=n, position=pos, has_pose=has_pose,
                                  rotation=tuple(float(v) for v in h.rotation) if has_pose else None,
                                  sensor=sensor, acquired=acquired))
            cb = _val(node, "cartesianBounds")
            if cb is not None and not isinstance(cb, (str, float, int)):
                vals = [_val(cb, k) for k in ("xMinimum", "yMinimum", "zMinimum", "xMaximum", "yMaximum", "zMaximum")]
                if all(isinstance(v, float) for v in vals):
                    # Writers disagree on whether cartesianBounds are local or global, so
                    # these are reported as stored; analysis uses bounds measured from points.
                    c = np.array([vals[:3], vals[3:]])
                    lo = np.minimum(lo, c.min(0))
                    hi = np.maximum(hi, c.max(0))

        coord = _val(root, "coordinateMetadata")
        coord = coord if isinstance(coord, str) and coord.strip() else None
        if coord is None:
            absent.add("coordinateMetadata")
        lib = _val(root, "e57LibraryVersion")
        read = {
            "scan count": str(e.scan_count),
            "points": f"{total:,}",
            "point fields": ", ".join(sorted(fields)),
            "scans with pose": f"{sum(s.has_pose for s in scans)} of {len(scans)}",
        }
        if isinstance(lib, str):
            read["writer library"] = lib
        sensors = {f"{s.sensor.get('sensorVendor', '')} {s.sensor.get('sensorModel', '')}".strip() for s in scans if s.sensor}
        if sensors:
            read["scanner"] = ", ".join(sorted(sensors))
        if coord:
            read["coordinate metadata"] = coord[:200]
        notes = []
        if e.scan_count == 1 and not scans[0].has_pose:
            notes.append("Single scan without a pose: likely a merged/unified export. Scanner "
                         "positions are not recoverable from this file; import setups as CSV for plan checks.")
        descs = {_val(e.get_header(i).node, "description") for i in range(e.scan_count)}
        descs = {d for d in descs if isinstance(d, str) and d}
        if descs:
            read["description"] = "; ".join(sorted(descs))[:200]
        notes.append("E57 coordinates are metres by definition (ASTM E2807).")
        return CloudHeader(
            path=str(self.path), format="E57", reader=f"pye57 {_PYE57_VERSION}",
            file_size=os.path.getsize(self.path), point_count=total, scans=scans,
            bounds=(lo.tolist(), hi.tolist()) if np.isfinite(lo).all() else None,
            coordinate_metadata=coord, units="m", fields=sorted(fields), read=read,
            absent=sorted(absent), notes=notes)

    def iter_chunks(self, chunk_size: int = 2_000_000) -> Iterator[Chunk]:
        e = self._e57
        for i in range(e.scan_count):
            h = e.get_header(i)
            pf = h.point_fields
            if all(f in pf for f in ("cartesianX", "cartesianY", "cartesianZ")):
                names = ["cartesianX", "cartesianY", "cartesianZ"]
                spherical = False
            elif all(f in pf for f in ("sphericalRange", "sphericalAzimuth", "sphericalElevation")):
                names = ["sphericalRange", "sphericalAzimuth", "sphericalElevation"]
                spherical = True
            else:
                continue
            inv = "sphericalInvalidState" if spherical else "cartesianInvalidState"
            if inv in pf:
                names.append(inv)
            cap = min(chunk_size, max(h.point_count, 1))
            data, bufs = e.make_buffers(names, cap)
            reader = h.points.reader(bufs)
            rot = _quat_to_matrix(h.rotation) if h.has_pose() else None
            trans = np.asarray(h.translation, dtype=float) if h.has_pose() else None
            try:
                while True:
                    n = reader.read()
                    if n == 0:
                        break
                    a, b, c = (data[names[k]][:n].astype(np.float64) for k in range(3))
                    if spherical:
                        ce = np.cos(c)
                        xyz = np.column_stack([a * ce * np.cos(b), a * ce * np.sin(b), a * np.sin(c)])
                    else:
                        xyz = np.column_stack([a, b, c])
                    if inv in data:
                        xyz = xyz[data[inv][:n] == 0]
                    if rot is not None:
                        xyz = xyz @ rot.T + trans
                    yield Chunk(xyz=xyz, scan=i)
            finally:
                reader.close()


class _Writer(pye57.E57):
    """pye57 writes an empty coordinateMetadata in its default header and libE57
    forbids setting a child twice, so the header is written here instead."""

    def __init__(self, path, mode="w", coordinate_metadata=""):
        self._coord = coordinate_metadata
        super().__init__(path, mode=mode)

    def write_default_header(self):
        import uuid

        imf = self.image_file
        self.root.set("formatName", libe57.StringNode(imf, "ASTM E57 3D Imaging Data File"))
        self.root.set("guid", libe57.StringNode(imf, "{%s}" % uuid.uuid4()))
        self.root.set("versionMajor", libe57.IntegerNode(imf, libe57.E57_FORMAT_MAJOR))
        self.root.set("versionMinor", libe57.IntegerNode(imf, libe57.E57_FORMAT_MINOR))
        self.root.set("e57LibraryVersion", libe57.StringNode(imf, libe57.E57_LIBRARY_ID))
        self.root.set("coordinateMetadata", libe57.StringNode(imf, self._coord))
        cdt = libe57.StructureNode(imf)
        cdt.set("dateTimeValue", libe57.FloatNode(imf, 0.0))
        cdt.set("isAtomicClockReferenced", libe57.IntegerNode(imf, 0))
        self.root.set("creationDateTime", cdt)
        self.root.set("data3D", libe57.VectorNode(imf, True))
        self.root.set("images2D", libe57.VectorNode(imf, True))


def write_e57(path: str | Path, scans: list[dict], coordinate_metadata: str = "",
              sensor: dict | None = None) -> None:
    """Write scans (local XYZ + pose) to E57. Used by the synthetic generator."""
    path = str(path)
    if os.path.exists(path):
        os.remove(path)
    e = _Writer(path, mode="w", coordinate_metadata=coordinate_metadata)
    for s in scans:
        xyz = s["xyz"]
        data = {"cartesianX": xyz[:, 0].copy(), "cartesianY": xyz[:, 1].copy(), "cartesianZ": xyz[:, 2].copy()}
        if "intensity" in s:
            data["intensity"] = s["intensity"].astype(np.float32)
        e.write_scan_raw(data, name=s["name"], rotation=np.array(s.get("rotation", [1, 0, 0, 0]), float),
                         translation=np.array(s["translation"], float))
        node = e.data3d[e.data3d.childCount() - 1]
        for k, v in (sensor or {}).items():
            node.set(k, libe57.StringNode(e.image_file, v))
    e.close()
